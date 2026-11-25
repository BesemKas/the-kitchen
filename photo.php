<?php
// Serves a product label photo to logged-in users: photo.php?id=123
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
send_security_headers();
start_session();

if (!current_user()) {
    http_response_code(401);
    exit;
}
$id = (int)($_GET['id'] ?? 0);
$st = db()->prepare('SELECT mime, data FROM product_photos WHERE id = ?');
$st->execute([$id]);
$row = $st->fetch();
if (!$row) {
    http_response_code(404);
    exit;
}
$bytes = base64_decode((string)$row['data'], true);
if ($bytes === false) {
    http_response_code(500);
    exit;
}
header('Content-Type: ' . (in_array($row['mime'], ['image/jpeg', 'image/png', 'image/webp'], true) ? $row['mime'] : 'application/octet-stream'));
header('Content-Length: ' . strlen($bytes));
header('Cache-Control: private, max-age=604800, immutable');   // a photo id never changes content
header('X-Content-Type-Options: nosniff');
echo $bytes;
