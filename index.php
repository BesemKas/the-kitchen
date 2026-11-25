<?php
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
send_security_headers();
start_session();

$error = '';
if (($_POST['action'] ?? '') === 'login') {
    if (!hash_equals(csrf_token(), $_POST['csrf'] ?? '')) {
        $error = 'Form expired, try again.';
    } else {
        $st = db()->prepare('SELECT id, password_hash FROM users WHERE username = ?');
        $st->execute([strtolower(trim($_POST['username'] ?? ''))]);
        $row = $st->fetch();
        if ($row && password_verify($_POST['password'] ?? '', $row['password_hash'])) {
            log_in((int)$row['id'], !empty($_POST['remember']));
            header('Location: ' . base_path());
            exit;
        }
        sleep(1);
        $error = 'Wrong username or password.';
    }
}

$user = current_user();
if ($user) {
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
<link rel="stylesheet" href="assets/app.css?v=8">
</head>
<?php if (!$user): ?>
<body class="auth">
<main class="card auth-card">
  <h1>Kitchen Budget</h1>
  <?php if ($error): ?><p class="error"><?= h($error) ?></p><?php endif; ?>
  <form method="post" class="stack">
    <input type="hidden" name="action" value="login">
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <label>Username <input name="username" autocomplete="username" autocapitalize="none" required></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <label class="row"><input type="checkbox" name="remember" value="1" checked> Keep me logged in</label>
    <button class="btn primary" type="submit">Log in</button>
  </form>
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
<script src="assets/app.js?v=8"></script>
</body>
<?php endif; ?>
</html>
