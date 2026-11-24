<?php
declare(strict_types=1);

/*
 * Nightly database backup for Kitchen Budget.
 *
 * Run from a cPanel cron job (never from the web):
 *   /usr/local/bin/php /home1/tru645/kitchen-tools/backup.php
 *
 * Writes kitchen-YYYYMMDD-HHMMSS.sql.gz to a folder outside public_html and keeps the newest 14.
 * The file is a plain SQL dump: restore it with phpMyAdmin → Import, or
 *   gunzip < kitchen-....sql.gz | mysql -u USER -p DATABASE
 *
 * Optional arguments: --config=/path/to/config.php --dir=/path/to/backups --keep=14
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$opts = getopt('', ['config::', 'dir::', 'keep::']);
$home = getenv('HOME') ?: dirname(__DIR__);
$configFile = $opts['config'] ?? $home . '/public_html/app/config.php';
$dir = rtrim($opts['dir'] ?? $home . '/kitchen-backups', '/');
$keep = max(1, (int)($opts['keep'] ?? 14));

if (!is_file($configFile)) {
    fwrite(STDERR, "Config not found: $configFile\n");
    exit(1);
}
$c = require $configFile;
date_default_timezone_set($c['timezone'] ?? 'Africa/Johannesburg');
$pdo = new PDO('mysql:host=' . $c['db_host'] . ';dbname=' . $c['db_name'] . ';charset=utf8mb4', $c['db_user'], $c['db_pass'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_NUM,
]);

if (!is_dir($dir) && !mkdir($dir, 0700, true)) {
    fwrite(STDERR, "Cannot create $dir\n");
    exit(1);
}
$file = $dir . '/kitchen-' . date('Ymd-His') . '.sql.gz';
$gz = gzopen($file, 'wb6');
$w = static function (string $s) use ($gz): void {
    gzwrite($gz, $s);
};

$w("-- Kitchen Budget backup of `{$c['db_name']}` at " . date('c') . "\n");
$w("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n");

$tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
foreach ($tables as $table) {
    $create = $pdo->query("SHOW CREATE TABLE `$table`")->fetch()[1];
    $w("DROP TABLE IF EXISTS `$table`;\n$create;\n");
    $rows = $pdo->query("SELECT * FROM `$table`");
    $batch = [];
    while ($row = $rows->fetch()) {
        $batch[] = '(' . implode(',', array_map(static fn($v) => $v === null ? 'NULL' : $pdo->quote((string)$v), $row)) . ')';
        if (count($batch) === 200) {
            $w("INSERT INTO `$table` VALUES\n" . implode(",\n", $batch) . ";\n");
            $batch = [];
        }
    }
    if ($batch) {
        $w("INSERT INTO `$table` VALUES\n" . implode(",\n", $batch) . ";\n");
    }
    $w("\n");
}
$w("SET FOREIGN_KEY_CHECKS = 1;\n");
gzclose($gz);
chmod($file, 0600);

$all = glob($dir . '/kitchen-*.sql.gz') ?: [];
rsort($all);
foreach (array_slice($all, $keep) as $old) {
    unlink($old);
}
echo 'Backup written: ' . $file . ' (' . round(filesize($file) / 1024, 1) . " KB)\n";
