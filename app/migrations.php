<?php
declare(strict_types=1);

/*
 * Schema migrations.
 *
 * app/schema.sql is version 1 (what setup.php creates). Every change after that is a numbered entry
 * below. On each API call the app compares `settings.schema_version` with the highest number here and
 * runs whatever is missing, in order, once. Never edit a migration that has shipped: add a new one.
 *
 * Keep statements MySQL 5.7-compatible (no `ADD COLUMN IF NOT EXISTS`, no CTEs).
 */

const MIGRATIONS = [
    2 => [
        // recipe maker v2
        "ALTER TABLE recipes ADD COLUMN prep_minutes INT UNSIGNED NULL, ADD COLUMN cook_minutes INT UNSIGNED NULL",
        "ALTER TABLE recipe_items ADD COLUMN note VARCHAR(120) NULL",
        "CREATE TABLE recipe_steps (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            recipe_id INT UNSIGNED NOT NULL,
            sort INT NOT NULL DEFAULT 0,
            body TEXT NOT NULL,
            timer_minutes INT UNSIGNED NULL,
            INDEX (recipe_id, sort),
            FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        // cooked portions in the fridge, one row per cooked batch
        "CREATE TABLE fridge (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            recipe_id INT UNSIGNED NULL,
            name VARCHAR(120) NOT NULL,
            portions DECIMAL(6,2) NOT NULL,
            grams_per_portion INT UNSIGNED NULL,
            cost_per_portion DECIMAL(10,2) NULL,
            cooked_on DATE NOT NULL,
            user_id INT UNSIGNED NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (cooked_on),
            FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        // takeaways are logged as trips of kind 'eating_out' so they never count against groceries
        "ALTER TABLE trips ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'groceries', ADD INDEX (kind, trip_date)",
        "INSERT IGNORE INTO settings (k, v) VALUES ('takeaway_weekly', '100.00')",
    ],
    3 => [
        // a planned meal can be marked eaten; portions taken from the fridge are remembered so undo can put them back
        "ALTER TABLE plan ADD COLUMN eaten_at DATETIME NULL, ADD COLUMN fridge_taken DECIMAL(6,2) NOT NULL DEFAULT 0",
    ],
    4 => [
        // per-person daily targets, set by each person for themselves
        "ALTER TABLE users ADD COLUMN protein_target_g INT UNSIGNED NULL, ADD COLUMN kj_target INT UNSIGNED NULL",
    ],
    5 => [
        // what's at home, in each product's own unit (g, kg, ml, l or items)
        "CREATE TABLE pantry (
            product_id INT UNSIGNED PRIMARY KEY,
            amount DECIMAL(12,3) NOT NULL DEFAULT 0,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        // the app's estimate at checkout, to compare with the till slip
        "ALTER TABLE trips ADD COLUMN estimate DECIMAL(10,2) NULL",
        // how often and when a product was last bought, for the "bought before" picker
        "ALTER TABLE products ADD COLUMN bought_count INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN last_bought DATE NULL",
        "INSERT IGNORE INTO settings (k, v) VALUES ('aisle_order', '[\"Fresh produce\",\"Meat & fish\",\"Dairy & eggs\",\"Bakery\",\"Pantry\",\"Frozen\",\"Household\"]')",
    ],
    6 => [
        // changes made offline are replayed later; this makes a replay of an already-saved change a no-op
        "CREATE TABLE op_log (
            op_id CHAR(36) PRIMARY KEY,
            response MEDIUMTEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ],
    7 => [
        // Everyone gets their own app: own list, shops, prices, plan, fridge, pantry, budget and history.
        // Only recipes (and the product facts recipes are built from) stay shared.
        // Everything that exists now goes to Jano's account; failing that, to the first account that isn't Qara's.
        "SET @owner = COALESCE(
            (SELECT id FROM users WHERE LOWER(username) IN ('jano', 'besem', 'besemkas') ORDER BY id LIMIT 1),
            (SELECT MIN(id) FROM users WHERE LOWER(username) <> 'qara'),
            (SELECT MIN(id) FROM users))",

        "CREATE TABLE user_settings (
            user_id INT UNSIGNED NOT NULL,
            k VARCHAR(40) NOT NULL,
            v TEXT NOT NULL,
            PRIMARY KEY (user_id, k),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "INSERT INTO user_settings (user_id, k, v) SELECT @owner, k, v FROM settings WHERE k IN ('monthly_budget', 'takeaway_weekly', 'aisle_order') AND @owner IS NOT NULL",
        "DELETE FROM settings WHERE k IN ('monthly_budget', 'takeaway_weekly', 'aisle_order')",

        // shops belong to someone; shop names only need to be unique per person
        "ALTER TABLE stores ADD COLUMN user_id INT UNSIGNED NULL AFTER id",
        "UPDATE stores SET user_id = @owner",
        "ALTER TABLE stores DROP INDEX name, ADD UNIQUE KEY user_name (user_id, name), ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",

        "ALTER TABLE list_items ADD COLUMN user_id INT UNSIGNED NULL AFTER id, ADD INDEX (user_id), ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
        "UPDATE list_items SET user_id = @owner",

        "ALTER TABLE plan ADD COLUMN user_id INT UNSIGNED NULL AFTER id, ADD INDEX user_date (user_id, plan_date), ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
        "UPDATE plan SET user_id = @owner",

        "UPDATE fridge SET user_id = @owner",
        "UPDATE trips SET user_id = @owner",

        // pantry and 'bought before' are per person
        "ALTER TABLE pantry ADD COLUMN user_id INT UNSIGNED NULL FIRST, ADD COLUMN bought_count INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN last_bought DATE NULL, ADD INDEX (product_id)",
        "UPDATE pantry SET user_id = @owner",
        "DELETE FROM pantry WHERE user_id IS NULL",
        "ALTER TABLE pantry DROP PRIMARY KEY, MODIFY user_id INT UNSIGNED NOT NULL, ADD PRIMARY KEY (user_id, product_id), ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
        "INSERT INTO pantry (user_id, product_id, amount, bought_count, last_bought)
            SELECT @owner, id, 0, bought_count, last_bought FROM products WHERE bought_count > 0 AND @owner IS NOT NULL
            ON DUPLICATE KEY UPDATE bought_count = VALUES(bought_count), last_bought = VALUES(last_bought)",
        "ALTER TABLE products DROP COLUMN bought_count, DROP COLUMN last_bought",
    ],
    8 => [
        // health info (shared product facts): Nutri-Score and NOVA from Open Food Facts, additives, ingredients
        "ALTER TABLE products
            ADD COLUMN nutriscore CHAR(1) NULL,
            ADD COLUMN nova TINYINT UNSIGNED NULL,
            ADD COLUMN additives VARCHAR(400) NULL,
            ADD COLUMN ingredients TEXT NULL,
            ADD COLUMN off_checked_at DATETIME NULL",
        // label photos, kept as base64 text so backups stay plain SQL
        "CREATE TABLE product_photos (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            product_id INT UNSIGNED NOT NULL,
            kind VARCHAR(12) NOT NULL DEFAULT 'label',
            mime VARCHAR(20) NOT NULL DEFAULT 'image/jpeg',
            data MEDIUMTEXT NOT NULL,
            user_id INT UNSIGNED NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (product_id),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ],
    9 => [
        // per person: "always alert me" / "don't flag" for an E-number, a group (group:sweeteners) or a word (peanut)
        "CREATE TABLE ingredient_alerts (
            user_id INT UNSIGNED NOT NULL,
            code VARCHAR(40) NOT NULL,
            mode VARCHAR(6) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, code),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        // cooked portions can live in the freezer; moved_on is when they last moved (frozen or thawed)
        "ALTER TABLE fridge ADD COLUMN location VARCHAR(7) NOT NULL DEFAULT 'fridge', ADD COLUMN moved_on DATE NULL",
        // budget runs from payday to payday; marked dates cover early (December) or moved paydays
        "CREATE TABLE pay_dates (
            user_id INT UNSIGNED NOT NULL,
            paid_on DATE NOT NULL,
            PRIMARY KEY (user_id, paid_on),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ],
    10 => [
        // more people: admin, disabled accounts, last seen; recipes owned and private unless shared
        "SET @owner = COALESCE(
            (SELECT id FROM users WHERE LOWER(username) IN ('jano', 'besem', 'besemkas') ORDER BY id LIMIT 1),
            (SELECT MIN(id) FROM users WHERE LOWER(username) <> 'qara'),
            (SELECT MIN(id) FROM users))",
        "ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN disabled TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN last_seen DATETIME NULL",
        "UPDATE users SET is_admin = 1 WHERE id = @owner",
        // existing recipes were shared between Jano and Qara: keep them visible to both by sharing them
        "ALTER TABLE recipes ADD COLUMN user_id INT UNSIGNED NULL AFTER id, ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0, ADD INDEX (user_id), ADD INDEX (is_public)",
        "UPDATE recipes SET user_id = @owner, is_public = 1",
        "ALTER TABLE recipes ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE products ADD COLUMN created_by INT UNSIGNED NULL, ADD FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL",
        "CREATE TABLE rate_limits (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            bucket VARCHAR(80) NOT NULL,
            at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (bucket, at)
        ) ENGINE=InnoDB",
        "CREATE TABLE password_resets (
            token_hash CHAR(64) PRIMARY KEY,
            user_id INT UNSIGNED NOT NULL,
            expires_at DATETIME NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB",
        "INSERT IGNORE INTO settings (k, v) VALUES ('signups_open', '1')",
    ],
    // households: people invite each other; a shared kitchen is owned by a hidden "kitchen" account, so anyone can leave
    11 => [
        "ALTER TABLE users ADD COLUMN is_kitchen TINYINT(1) NOT NULL DEFAULT 0",
        "CREATE TABLE IF NOT EXISTS households (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(60) NOT NULL,
            mode VARCHAR(10) NOT NULL DEFAULT 'separate',
            kitchen_user_id INT UNSIGNED NOT NULL,
            created_by INT UNSIGNED NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (kitchen_user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        // one household per person: the person is the primary key
        "CREATE TABLE IF NOT EXISTS household_members (
            user_id INT UNSIGNED NOT NULL PRIMARY KEY,
            household_id INT UNSIGNED NOT NULL,
            role VARCHAR(10) NOT NULL DEFAULT 'member',
            joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (household_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
        ) ENGINE=InnoDB",
        "CREATE TABLE IF NOT EXISTS household_invites (
            token_hash CHAR(64) PRIMARY KEY,
            household_id INT UNSIGNED NOT NULL,
            invited_by INT UNSIGNED NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME NULL,
            used_by INT UNSIGNED NULL,
            FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
            FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB",
        // who logged a shop, so a shared kitchen's budget shows who spent it
        "ALTER TABLE trips ADD COLUMN added_by INT UNSIGNED NULL, ADD FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL",
        "UPDATE trips SET added_by = user_id",
    ],
    // products people agreed to share with Open Food Facts, sent a few at a time
    12 => [
        "CREATE TABLE IF NOT EXISTS off_contributions (
            product_id INT UNSIGNED NOT NULL PRIMARY KEY,
            user_id INT UNSIGNED NULL,
            status VARCHAR(10) NOT NULL DEFAULT 'pending',
            attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
            last_error VARCHAR(255) NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX (status, updated_at),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB",
    ],
    // pilot numbers: which days people used the app, what they scanned, and what they told us
    13 => [
        "CREATE TABLE IF NOT EXISTS user_days (
            user_id INT UNSIGNED NOT NULL,
            day DATE NOT NULL,
            PRIMARY KEY (user_id, day),
            INDEX (day),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB",
        "INSERT IGNORE INTO user_days (user_id, day) SELECT id, DATE(last_seen) FROM users WHERE last_seen IS NOT NULL AND is_kitchen = 0",
        "CREATE TABLE IF NOT EXISTS scan_log (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNSIGNED NULL,
            kind VARCHAR(10) NOT NULL DEFAULT 'barcode',
            result VARCHAR(10) NOT NULL,
            at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (at),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB",
        "CREATE TABLE IF NOT EXISTS feedback (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNSIGNED NULL,
            kind VARCHAR(10) NOT NULL DEFAULT 'note',
            used TEXT NULL,
            annoyed TEXT NULL,
            missing TEXT NULL,
            note TEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX (created_at),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB",
    ],
];

function schema_version(): int
{
    try {
        return (int)setting('schema_version', '1');
    } catch (PDOException $e) {
        return 1;
    }
}

function run_migrations(): void
{
    $latest = max(array_keys(MIGRATIONS));
    if (schema_version() >= $latest) {
        return;
    }
    // one request migrates; others wait up to 10 s, then carry on with whatever is there
    $got = (int)db()->query("SELECT GET_LOCK('kitchen_migrate', 10)")->fetchColumn();
    try {
        foreach (MIGRATIONS as $version => $statements) {
            if (schema_version() >= $version) {
                continue;
            }
            foreach ($statements as $sql) {
                db()->exec($sql);
            }
            set_setting('schema_version', (string)$version);
        }
    } finally {
        if ($got) {
            db()->query("SELECT RELEASE_LOCK('kitchen_migrate')");
        }
    }
}
