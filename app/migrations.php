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
