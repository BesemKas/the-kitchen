<?php
declare(strict_types=1);

const REMEMBER_COOKIE = 'budget_remember';
const REMEMBER_DAYS = 60;

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    exit('Setup needed: copy app/config.sample.php to app/config.php and fill in your MySQL details.');
}
$CONFIG = require $configFile;
date_default_timezone_set($CONFIG['timezone'] ?? 'Africa/Johannesburg');

function config(string $key, $default = null)
{
    global $CONFIG;
    return $CONFIG[$key] ?? $default;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . config('db_host') . ';dbname=' . config('db_name') . ';charset=utf8mb4';
        $pdo = new PDO($dsn, config('db_user'), config('db_pass'), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->exec("SET time_zone = '" . (new DateTime())->format('P') . "'");
    }
    return $pdo;
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (($_SERVER['SERVER_PORT'] ?? '') === '443');
}

function base_path(): string
{
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return $dir === '' ? '/' : $dir . '/';
}

function cookie_options(int $expires): array
{
    return [
        'expires' => $expires,
        'path' => base_path(),
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ];
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('budget_sess');
    $opts = cookie_options(0);
    unset($opts['expires']);
    $opts['lifetime'] = 0;
    session_set_cookie_params($opts);
    session_start();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    if (empty($_SESSION['user_id'])) {
        login_from_cookie();
    }
}

function csrf_token(): string
{
    return $_SESSION['csrf'];
}

function current_user(): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }
    $st = db()->prepare('SELECT id, username, display_name FROM users WHERE id = ?');
    $st->execute([$_SESSION['user_id']]);
    return $st->fetch() ?: null;
}

function log_in(int $userId, bool $remember): void
{
    session_regenerate_id(true);
    $_SESSION['user_id'] = $userId;
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    if ($remember) {
        $selector = bin2hex(random_bytes(12));
        $validator = bin2hex(random_bytes(32));
        $expires = time() + REMEMBER_DAYS * 86400;
        db()->prepare('INSERT INTO auth_tokens (selector, validator_hash, user_id, expires_at) VALUES (?, ?, ?, ?)')
            ->execute([$selector, hash('sha256', $validator), $userId, date('Y-m-d H:i:s', $expires)]);
        setcookie(REMEMBER_COOKIE, $selector . ':' . $validator, cookie_options($expires));
    }
}

function login_from_cookie(): void
{
    $raw = $_COOKIE[REMEMBER_COOKIE] ?? '';
    if (!preg_match('/^([a-f0-9]{24}):([a-f0-9]{64})$/', $raw, $m)) {
        return;
    }
    try {
        $st = db()->prepare('SELECT user_id, validator_hash FROM auth_tokens WHERE selector = ? AND expires_at > NOW()');
        $st->execute([$m[1]]);
        $row = $st->fetch();
    } catch (PDOException $e) {
        return;
    }
    if ($row && hash_equals($row['validator_hash'], hash('sha256', $m[2]))) {
        session_regenerate_id(true);
        $_SESSION['user_id'] = (int)$row['user_id'];
    } else {
        setcookie(REMEMBER_COOKIE, '', cookie_options(time() - 3600));
    }
}

function log_out(): void
{
    $raw = $_COOKIE[REMEMBER_COOKIE] ?? '';
    if (preg_match('/^([a-f0-9]{24}):/', $raw, $m)) {
        db()->prepare('DELETE FROM auth_tokens WHERE selector = ?')->execute([$m[1]]);
    }
    setcookie(REMEMBER_COOKIE, '', cookie_options(time() - 3600));
    $_SESSION = [];
    session_regenerate_id(true);
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function h(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}

function setting(string $key, string $default = ''): string
{
    $st = db()->prepare('SELECT v FROM settings WHERE k = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? $default : (string)$v;
}

function set_setting(string $key, string $value): void
{
    db()->prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)')
        ->execute([$key, $value]);
}

function send_security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
}
