<?php
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
send_security_headers();
start_session();

$error = '';
$notice = '';
$page = isset($_GET['signup']) ? 'signup' : (isset($_GET['reset']) ? 'reset' : (isset($_GET['privacy']) ? 'privacy' : 'login'));
$signupsOpen = setting('signups_open', '1') === '1';
$formOk = fn() => hash_equals(csrf_token(), $_POST['csrf'] ?? '');

// a household invite link (?join=…) is remembered through log-in or sign-up, then opened in the app
if (isset($_GET['join']) && preg_match('/^[0-9a-f]{48}$/', (string)$_GET['join'])) {
    $_SESSION['join'] = (string)$_GET['join'];
    if (current_user()) {
        unset($_SESSION['join']);
        header('Location: ' . base_path() . '#join=' . $_GET['join']);
        exit;
    }
}
$invite = null;
if (!empty($_SESSION['join'])) {
    try {
        $st = db()->prepare('SELECT h.name household, u.display_name inviter FROM household_invites i JOIN households h ON h.id = i.household_id
                             LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > NOW()');
        $st->execute([hash('sha256', (string)$_SESSION['join'])]);
        $invite = $st->fetch() ?: null;
    } catch (PDOException $e) {
        $invite = null;   // tables not there yet
    }
}
// someone invited into a household may sign up even when sign-ups are closed
$signupsOpen = $signupsOpen || $invite !== null;
$after = function (string $hash = ''): string {
    $tok = (string)($_SESSION['join'] ?? '');
    unset($_SESSION['join']);
    return base_path() . ($tok !== '' ? '#join=' . $tok . ($hash === '#welcome' ? '&new' : '') : $hash);
};

if (($_POST['action'] ?? '') === 'login') {
    if (!$formOk()) {
        $error = 'Form expired, try again.';
    } elseif (!rate_ok('login:' . client_ip(), 10, 900)) {
        $error = 'Too many tries. Wait 15 minutes and try again.';
    } else {
        $st = db()->prepare('SELECT * FROM users WHERE username = ?');
        $st->execute([strtolower(trim($_POST['username'] ?? ''))]);
        $row = $st->fetch();
        if ($row && password_verify($_POST['password'] ?? '', $row['password_hash'])) {
            if (!empty($row['disabled'])) {
                $error = 'This account is switched off. Ask the person who runs the app.';
            } else {
                $to = $after();
                log_in((int)$row['id'], !empty($_POST['remember']));
                header('Location: ' . $to);
                exit;
            }
        } else {
            sleep(1);
            $error = 'Wrong username or password.';
        }
    }
}

if (($_POST['action'] ?? '') === 'signup') {
    $page = 'signup';
    $username = strtolower(trim((string)($_POST['username'] ?? '')));
    $name = trim((string)($_POST['display_name'] ?? ''));
    $pass = (string)($_POST['password'] ?? '');
    $started = (int)($_POST['t'] ?? 0);
    $sig = (string)($_POST['ts'] ?? '');
    if (!$signupsOpen) {
        $error = 'Sign-ups are closed right now.';
    } elseif (!$formOk() || !hash_equals(hash_hmac('sha256', (string)$started, csrf_token()), $sig)) {
        $error = 'Form expired, try again.';
    } elseif (($_POST['website'] ?? '') !== '' || time() - $started < 3) {
        $error = 'Something went wrong. Try again.';   // bot trap: hidden field filled in, or sent too fast
    } elseif (!rate_ok('signup:' . client_ip(), 5, 86400)) {
        $error = 'Too many new accounts from here today. Try again tomorrow.';
    } elseif (!preg_match('/^[a-z0-9._-]{3,30}$/', $username)) {
        $error = 'Username: 3–30 letters, numbers, dots, dashes or underscores.';
    } elseif ($name === '' || mb_strlen($name) > 60) {
        $error = 'What should we call you?';
    } elseif (strlen($pass) < 8) {
        $error = 'Password must be at least 8 characters.';
    } elseif ($pass !== (string)($_POST['password2'] ?? '')) {
        $error = "The passwords don't match.";
    } else {
        $st = db()->prepare('SELECT 1 FROM users WHERE username = ?');
        $st->execute([$username]);
        if ($st->fetchColumn()) {
            $error = 'That username is taken.';
        } else {
            db()->prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)')
                ->execute([$username, $name, password_hash($pass, PASSWORD_DEFAULT)]);
            $to = $after('#welcome');
            log_in((int)db()->lastInsertId(), true);
            header('Location: ' . $to);
            exit;
        }
    }
}

$resetUser = null;
if ($page === 'reset') {
    $tok = (string)($_GET['reset'] ?? '');
    if (preg_match('/^[a-f0-9]{48}$/', $tok)) {
        $st = db()->prepare('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > NOW()');
        $st->execute([hash('sha256', $tok)]);
        $resetUser = $st->fetchColumn() ?: null;
    }
    if (!$resetUser) {
        $error = 'This reset link has expired or was already used. Ask for a new one.';
    } elseif (($_POST['action'] ?? '') === 'reset') {
        $pass = (string)($_POST['password'] ?? '');
        if (!$formOk()) {
            $error = 'Form expired, try again.';
        } elseif (strlen($pass) < 8) {
            $error = 'Password must be at least 8 characters.';
        } elseif ($pass !== (string)($_POST['password2'] ?? '')) {
            $error = "The passwords don't match.";
        } else {
            db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $resetUser]);
            db()->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$resetUser]);
            db()->prepare('DELETE FROM auth_tokens WHERE user_id = ?')->execute([$resetUser]);
            log_in((int)$resetUser, true);
            header('Location: ' . base_path());
            exit;
        }
    }
}

$user = current_user();
if ($user && $page !== 'privacy') {
    header('X-Kitchen-Shell: 1');   // lets the service worker keep this page for offline use
}
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e1110">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="csrf" content="<?= h(csrf_token()) ?>">
<title>Kitchen Budget</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/icon-180.png">
<link rel="stylesheet" href="assets/app.css?v=17">
</head>
<?php if (!$user || $page === 'privacy'): ?>
<body class="auth">
<main class="card auth-card">
  <h1>Kitchen Budget</h1>
  <?php if ($error): ?><p class="error"><?= h($error) ?></p><?php endif; ?>
  <?php if ($invite && $page !== 'privacy'): ?><p class="notice"><?= h($invite['inviter'] ?: 'Someone') ?> invited you to join the household “<?= h($invite['household']) ?>”. Log in, or create an account, and you'll be asked to join.</p><?php endif; ?>
<?php if ($page === 'privacy'): ?>
  <h2>Your data</h2>
  <div class="stack small">
    <p>Kitchen Budget is a small personal app. It keeps what you type or scan: your username, display name, a hashed password (nobody can read it), shopping lists, shops and prices, meal plans, cooked portions, budget, takeaways, ingredient alerts and the recipes you add.</p>
    <p><b>Who sees it:</b> only you, unless you join a household. In a household everyone sees each other's recipes and the people's names; if the household shares its kitchen, the shopping list, pantry, shops and prices, meal plan, fridge and grocery budget are shared too (your takeaways, ingredient alerts and targets stay yours). Product facts (names, barcodes, nutrition, label photos) are shared with everyone so a scan helps all users. Recipes are private unless you tap “Share with everyone”.</p>
    <p><b>Where it lives:</b> on the app's web host in a MySQL database, with nightly backups. It is never sold or shared. Barcodes are looked up on Open Food Facts; if label reading is switched on, label photos are sent to Anthropic's Claude to read the numbers.</p>
    <p><b>Open Food Facts:</b> only if you say yes, products you add (name, brand, pack size, ingredients, nutrition and label photos) are added to Open Food Facts, a free public food database. Once there they are public under open licences (ODbL for the data, CC BY-SA for photos). Your name, prices, lists, plans and budget are never sent. You can switch this off under Budget → Settings.</p>
    <p><b>Your rights:</b> under Budget → Settings you can download everything the app holds about you, or delete your account and all your data.</p>
  </div>
  <a class="btn" href="./">Back</a>
<?php elseif ($page === 'signup'): ?>
  <?php if (!$signupsOpen): ?>
    <p>Sign-ups are closed right now.</p><a class="btn" href="./">Log in</a>
  <?php else: $t = time(); ?>
  <form method="post" class="stack" autocomplete="on">
    <input type="hidden" name="action" value="signup">
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <input type="hidden" name="t" value="<?= $t ?>">
    <input type="hidden" name="ts" value="<?= h(hash_hmac('sha256', (string)$t, csrf_token())) ?>">
    <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
    <label>Your name <input name="display_name" required maxlength="60" value="<?= h($_POST['display_name'] ?? '') ?>" autocomplete="given-name"></label>
    <label>Username <input name="username" required autocapitalize="none" pattern="[a-zA-Z0-9._-]{3,30}" value="<?= h($_POST['username'] ?? '') ?>" autocomplete="username"></label>
    <label>Password <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <label>Password again <input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
    <p class="small muted">Your list, plan and budget are yours alone. <a href="?privacy">How your data is kept</a></p>
    <button class="btn primary" type="submit">Create my account</button>
  </form>
  <a class="small" href="./">I already have an account</a>
  <?php endif; ?>
<?php elseif ($page === 'reset' && $resetUser): ?>
  <form method="post" class="stack">
    <input type="hidden" name="action" value="reset">
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <label>New password <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <label>New password again <input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
    <button class="btn primary" type="submit">Set password and log in</button>
  </form>
<?php else: ?>
  <form method="post" class="stack" action="./">
    <input type="hidden" name="action" value="login">
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <label>Username <input name="username" autocomplete="username" autocapitalize="none" required></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <label class="row"><input type="checkbox" name="remember" value="1" checked> Keep me logged in</label>
    <button class="btn primary" type="submit">Log in</button>
  </form>
  <?php if ($signupsOpen): ?><a class="btn" href="?signup">Create an account</a><?php endif; ?>
  <p class="small muted">Forgot your password? Ask the person who runs the app for a reset link. · <a href="?privacy">Your data</a></p>
<?php endif; ?>
</main>
</body>
<?php else: ?>
<body>
<header class="topbar">
  <h1 id="title">List</h1>
  <button id="budgetPill" class="pill" type="button"></button>
</header>
<div id="netbar" class="netbar" role="status" aria-live="polite" hidden></div>
<main id="view" class="view"></main>
<nav class="tabs" aria-label="Main">
  <a href="#list" data-tab="list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/></svg>List</a>
  <a href="#products" data-tab="products"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/></svg>Products</a>
  <a href="#plan" data-tab="plan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>Plan</a>
  <a href="#recipes" data-tab="recipes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z"/><path d="M2 11h20M9 7c0-1.5 1-2 1-3M14 7c0-1.5 1-2 1-3"/></svg>Recipes</a>
  <a href="#budget" data-tab="budget"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/></svg>Budget</a>
</nav>
<div id="sheet" class="sheet" hidden><div class="sheet-body" id="sheetBody"></div></div>
<div id="toast" class="toast" hidden></div>
<script src="assets/zxing-browser.min.js"></script>
<script src="assets/app.js?v=17"></script>
</body>
<?php endif; ?>
</html>
