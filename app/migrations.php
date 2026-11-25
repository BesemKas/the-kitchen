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
        // Everything that exists now goes to Besem's account (falls back to the first account).
        "SET @owner = COALESCE((SELECT id FROM users WHERE username IN ('besem', 'besemkas') ORDER BY id LIMIT 1), (SELECT MIN(id) FROM users))",

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
