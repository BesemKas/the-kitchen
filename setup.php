<?php
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
send_security_headers();
start_session();

$errors = [];
$done = false;

try {
    $hasUsers = (bool)db()->query("SHOW TABLES LIKE 'users'")->fetchColumn()
        && (int)db()->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0;
} catch (PDOException $e) {
    exit('Could not connect to MySQL. Check app/config.php. (' . h($e->getMessage()) . ')');
}

if ($hasUsers) {
    exit('Already set up. Delete setup.php from the server.');
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!hash_equals(csrf_token(), $_POST['csrf'] ?? '')) {
        $errors[] = 'Form expired, try again.';
    }
    $people = [];
    foreach ([1, 2] as $i) {
        $u = strtolower(trim($_POST["user$i"] ?? ''));
        $n = trim($_POST["name$i"] ?? '');
        $p = $_POST["pass$i"] ?? '';
        if ($u === '' && $i === 2) {
            continue;
        }
        if (!preg_match('/^[a-z0-9_.-]{2,40}$/', $u)) {
            $errors[] = "Person $i: username must be 2–40 letters/numbers.";
        }
        if (strlen($p) < 8) {
            $errors[] = "Person $i: password must be at least 8 characters.";
        }
        $people[] = [$u, $n !== '' ? $n : $u, $p];
    }
    $budget = (float)($_POST['budget'] ?? 0);
    $stores = array_filter(array_map('trim', explode(',', $_POST['stores'] ?? '')));

    if (!$errors) {
        $sql = file_get_contents(__DIR__ . '/app/schema.sql');
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
            db()->exec($stmt);
        }
        $ins = db()->prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)');
        foreach ($people as [$u, $n, $p]) {
            $ins->execute([$u, $n, password_hash($p, PASSWORD_DEFAULT)]);
        }
        $si = db()->prepare('INSERT IGNORE INTO stores (name) VALUES (?)');
        foreach ($stores as $s) {
            $si->execute([mb_substr($s, 0, 60)]);
        }
        set_setting('monthly_budget', number_format(max(0, $budget), 2, '.', ''));
        $done = true;
    }
}
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup – Kitchen Budget</title><link rel="stylesheet" href="assets/app.css?v=2"></head>
<body class="auth"><main class="card auth-card">
<h1>Kitchen Budget setup</h1>
<?php if ($done): ?>
  <p>All set. <strong>Now delete <code>setup.php</code> from the server</strong>, then <a href="./">log in</a>.</p>
<?php else: ?>
  <?php foreach ($errors as $e): ?><p class="error"><?= h($e) ?></p><?php endforeach; ?>
  <form method="post" class="stack">
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <fieldset><legend>Person 1</legend>
      <label>Username <input name="user1" required autocomplete="off" value="<?= h($_POST['user1'] ?? '') ?>"></label>
      <label>Display name <input name="name1" value="<?= h($_POST['name1'] ?? '') ?>"></label>
      <label>Password <input name="pass1" type="password" required minlength="8" autocomplete="new-password"></label>
    </fieldset>
    <fieldset><legend>Person 2 (optional)</legend>
      <label>Username <input name="user2" autocomplete="off" value="<?= h($_POST['user2'] ?? '') ?>"></label>
      <label>Display name <input name="name2" value="<?= h($_POST['name2'] ?? '') ?>"></label>
      <label>Password <input name="pass2" type="password" minlength="8" autocomplete="new-password"></label>
    </fieldset>
    <label>Monthly grocery budget (R) <input name="budget" type="number" step="0.01" min="0" value="<?= h($_POST['budget'] ?? '2200') ?>"></label>
    <label>Shops (comma separated) <input name="stores" value="<?= h($_POST['stores'] ?? 'Checkers, Shoprite, Pick n Pay') ?>"></label>
    <button class="btn primary" type="submit">Create</button>
  </form>
<?php endif; ?>
</main></body></html>
