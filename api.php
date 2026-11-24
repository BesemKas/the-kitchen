<?php
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/migrations.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
send_security_headers();
start_session();

const NUTRIENTS = ['energy_kj', 'protein_g', 'carbs_g', 'sugar_g', 'fat_g', 'satfat_g', 'fibre_g', 'sodium_mg'];
const UNITS = ['each', 'g', 'kg', 'ml', 'l'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

function out($data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function fail(string $msg, int $code = 400): never
{
    out(['error' => $msg], $code);
}

function str_in(array $in, string $key, int $max, bool $required = false): ?string
{
    $v = isset($in[$key]) ? trim((string)$in[$key]) : '';
    if ($v === '') {
        if ($required) {
            fail("Missing $key");
        }
        return null;
    }
    return mb_substr($v, 0, $max);
}

function num_in(array $in, string $key, ?float $default = null, float $min = 0, float $max = 1e9): ?float
{
    if (!isset($in[$key]) || $in[$key] === '' || $in[$key] === null) {
        return $default;
    }
    if (!is_numeric($in[$key])) {
        fail("$key must be a number");
    }
    $v = (float)$in[$key];
    if ($v < $min || $v > $max) {
        fail("$key out of range");
    }
    return $v;
}

function int_in(array $in, string $key, bool $required = true): ?int
{
    if (!isset($in[$key]) || $in[$key] === '' || $in[$key] === null) {
        if ($required) {
            fail("Missing $key");
        }
        return null;
    }
    if (!ctype_digit((string)$in[$key])) {
        fail("$key must be an id");
    }
    return (int)$in[$key];
}

function date_in(array $in, string $key, ?string $default = null): string
{
    $v = (string)($in[$key] ?? '');
    if ($v === '' && $default !== null) {
        return $default;
    }
    $d = DateTime::createFromFormat('!Y-m-d', $v);
    if (!$d || $d->format('Y-m-d') !== $v) {
        fail("$key must be a date (YYYY-MM-DD)");
    }
    return $v;
}

function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

/** @return array<int, array<int, array{price: float, at: string}>> product_id => store_id => latest price */
function latest_prices(?array $productIds = null): array
{
    $sql = 'SELECT p.product_id, p.store_id, p.price, p.recorded_at FROM prices p
            JOIN (SELECT MAX(id) id FROM prices GROUP BY product_id, store_id) m ON m.id = p.id';
    $params = [];
    if ($productIds !== null) {
        if (!$productIds) {
            return [];
        }
        $sql .= ' WHERE p.product_id IN (' . implode(',', array_fill(0, count($productIds), '?')) . ')';
        $params = array_values($productIds);
    }
    $map = [];
    foreach (q($sql, $params) as $r) {
        $map[(int)$r['product_id']][(int)$r['store_id']] = ['price' => (float)$r['price'], 'at' => $r['recorded_at']];
    }
    return $map;
}

function best_price(array $byStore): ?float
{
    $min = null;
    foreach ($byStore as $p) {
        $min = $min === null ? $p['price'] : min($min, $p['price']);
    }
    return $min;
}

function record_price(int $productId, int $storeId, float $price, int $userId): void
{
    $last = q('SELECT price FROM prices WHERE product_id = ? AND store_id = ? ORDER BY id DESC LIMIT 1', [$productId, $storeId])->fetchColumn();
    if ($last === false || abs((float)$last - $price) > 0.004) {
        q('INSERT INTO prices (product_id, store_id, price, user_id) VALUES (?, ?, ?, ?)', [$productId, $storeId, $price, $userId]);
    }
}

function product_row(array $r, array $prices): array
{
    $r['id'] = (int)$r['id'];
    $r['pack_size'] = (float)$r['pack_size'];
    foreach (NUTRIENTS as $n) {
        $r[$n] = $r[$n] === null ? null : (float)$r[$n];
    }
    $r['prices'] = (object)($prices[$r['id']] ?? []);
    $r['best_price'] = best_price($prices[$r['id']] ?? []);
    unset($r['created_at']);
    return $r;
}

/** Multiplier from a recipe amount (in the product's unit) to its nutrition basis (per 100 g/ml or per item). */
function nutrition_factor(string $unit, float $amount): float
{
    switch ($unit) {
        case 'g':
        case 'ml':
            return $amount / 100;
        case 'kg':
        case 'l':
            return $amount * 10;
        default:
            return $amount;
    }
}

function recipes_with_costs(?int $onlyId = null): array
{
    $recipes = $onlyId === null
        ? q('SELECT * FROM recipes ORDER BY name')->fetchAll()
        : q('SELECT * FROM recipes WHERE id = ?', [$onlyId])->fetchAll();
    if (!$recipes) {
        return [];
    }
    $ids = array_column($recipes, 'id');
    $items = q('SELECT ri.*, p.name, p.unit, p.pack_size, ' . implode(', ', array_map(fn($n) => "p.$n", NUTRIENTS)) . '
                FROM recipe_items ri JOIN products p ON p.id = ri.product_id
                WHERE ri.recipe_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ') ORDER BY ri.sort, ri.id', $ids)->fetchAll();
    $prices = latest_prices(array_values(array_unique(array_column($items, 'product_id'))));
    $byRecipe = [];
    foreach ($items as $it) {
        $byRecipe[(int)$it['recipe_id']][] = $it;
    }
    $stepsByRecipe = [];
    foreach (q('SELECT recipe_id, body, timer_minutes FROM recipe_steps WHERE recipe_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ') ORDER BY sort, id', $ids) as $st) {
        $stepsByRecipe[(int)$st['recipe_id']][] = [
            'body' => $st['body'],
            'timer_minutes' => $st['timer_minutes'] === null ? null : (int)$st['timer_minutes'],
        ];
    }
    $result = [];
    foreach ($recipes as $r) {
        $cost = 0.0;
        $missing = 0;
        $nut = array_fill_keys(NUTRIENTS, 0.0);
        $nutKnown = array_fill_keys(NUTRIENTS, false);
        $nutMissing = 0;
        $list = [];
        foreach ($byRecipe[(int)$r['id']] ?? [] as $it) {
            $amount = (float)$it['amount'];
            $pack = max(0.001, (float)$it['pack_size']);
            $best = best_price($prices[(int)$it['product_id']] ?? []);
            $line = $best === null ? null : round($amount / $pack * $best, 2);
            if ($line === null) {
                $missing++;
            } else {
                $cost += $line;
            }
            if ($it['energy_kj'] === null && $it['protein_g'] === null) {
                $nutMissing++;
            } else {
                $f = nutrition_factor($it['unit'], $amount);
                foreach (NUTRIENTS as $n) {
                    if ($it[$n] !== null) {
                        $nut[$n] += (float)$it[$n] * $f;
                        $nutKnown[$n] = true;
                    }
                }
            }
            $list[] = [
                'product_id' => (int)$it['product_id'],
                'name' => $it['name'],
                'unit' => $it['unit'],
                'pack_size' => (float)$it['pack_size'],
                'amount' => $amount,
                'note' => $it['note'],
                'cost' => $line,
            ];
        }
        $servings = max(1, (int)$r['servings']);
        $perServing = [];
        foreach ($nut as $k => $v) {
            $perServing[$k] = $nutKnown[$k] ? round($v / $servings, 1) : null;
        }
        $result[] = [
            'id' => (int)$r['id'],
            'name' => $r['name'],
            'servings' => $servings,
            'instructions' => $r['instructions'],
            'prep_minutes' => $r['prep_minutes'] === null ? null : (int)$r['prep_minutes'],
            'cook_minutes' => $r['cook_minutes'] === null ? null : (int)$r['cook_minutes'],
            'items' => $list,
            'steps' => $stepsByRecipe[(int)$r['id']] ?? [],
            'cost' => round($cost, 2),
            'cost_per_serving' => round($cost / $servings, 2),
            'missing_prices' => $missing,
            'nutrition_per_serving' => $perServing,
            'missing_nutrition' => $nutMissing,
        ];
    }
    return $result;
}

function month_spent(string $month, string $kind = 'groceries'): float
{
    return (float)q("SELECT COALESCE(SUM(total), 0) FROM trips WHERE kind = ? AND DATE_FORMAT(trip_date, '%Y-%m') = ?", [$kind, $month])->fetchColumn();
}

/** Takeaway spend for the Monday-to-Sunday week containing $date, against the weekly allowance. */
function takeaway_week(?string $date = null): array
{
    $d = new DateTimeImmutable($date ?? 'today');
    $monday = $d->modify('-' . ((int)$d->format('N') - 1) . ' days');
    $sunday = $monday->modify('+6 days');
    $rows = q("SELECT id, trip_date, total, note FROM trips WHERE kind = 'eating_out' AND trip_date BETWEEN ? AND ? ORDER BY trip_date DESC, id DESC",
        [$monday->format('Y-m-d'), $sunday->format('Y-m-d')])->fetchAll();
    $spent = 0.0;
    foreach ($rows as &$r) {
        $r['id'] = (int)$r['id'];
        $r['total'] = (float)$r['total'];
        $spent += $r['total'];
    }
    unset($r);
    return [
        'weekly' => (float)setting('takeaway_weekly', '100'),
        'spent' => round($spent, 2),
        'from' => $monday->format('Y-m-d'),
        'to' => $sunday->format('Y-m-d'),
        'items' => $rows,
    ];
}

function fridge_list(): array
{
    $rows = q('SELECT f.*, r.servings FROM fridge f LEFT JOIN recipes r ON r.id = f.recipe_id WHERE f.portions > 0 ORDER BY f.cooked_on, f.id')->fetchAll();
    $out = [];
    $today = new DateTimeImmutable('today');
    foreach ($rows as $r) {
        $out[] = [
            'id' => (int)$r['id'],
            'recipe_id' => $r['recipe_id'] === null ? null : (int)$r['recipe_id'],
            'name' => $r['name'],
            'portions' => (float)$r['portions'],
            'grams_per_portion' => $r['grams_per_portion'] === null ? null : (int)$r['grams_per_portion'],
            'cost_per_portion' => $r['cost_per_portion'] === null ? null : (float)$r['cost_per_portion'],
            'cooked_on' => $r['cooked_on'],
            'age_days' => (int)$today->diff(new DateTimeImmutable($r['cooked_on']))->days,
        ];
    }
    return $out;
}

function off_lookup(string $barcode): ?array
{
    if (!function_exists('curl_init')) {
        return null;
    }
    $fields = 'product_name,brands,quantity,product_quantity,product_quantity_unit,nutriments';
    $ch = curl_init('https://world.openfoodfacts.org/api/v2/product/' . rawurlencode($barcode) . '.json?fields=' . $fields);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 6,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_USERAGENT => 'KitchenBudget/1.0 (personal grocery app)',
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if (!$body || $code !== 200) {
        return null;
    }
    $data = json_decode($body, true);
    return is_array($data) ? off_parse($data) : null;
}

function off_parse(array $data): ?array
{
    if ((int)($data['status'] ?? 0) !== 1 || empty($data['product'])) {
        return null;
    }
    $p = $data['product'];
    [$size, $unit] = parse_quantity((string)($p['quantity'] ?? ''));
    $n = $p['nutriments'] ?? [];
    $val = fn($k) => isset($n[$k]) && is_numeric($n[$k]) ? round((float)$n[$k], 2) : null;
    $kj = $val('energy-kj_100g') ?? $val('energy_100g');
    if ($kj === null && ($kcal = $val('energy-kcal_100g')) !== null) {
        $kj = round($kcal * 4.184, 1);
    }
    $sodium = isset($n['sodium_100g']) && is_numeric($n['sodium_100g']) ? (float)$n['sodium_100g'] : null;
    $nutrition = [
        'energy_kj' => $kj,
        'protein_g' => $val('proteins_100g'),
        'carbs_g' => $val('carbohydrates_100g'),
        'sugar_g' => $val('sugars_100g'),
        'fat_g' => $val('fat_100g'),
        'satfat_g' => $val('saturated-fat_100g'),
        'fibre_g' => $val('fiber_100g'),
        'sodium_mg' => $sodium === null ? null : round($sodium * 1000, 1),
    ];
    if ($unit === 'each') {
        // per-100g values don't apply to an item-priced product
        $nutrition = array_fill_keys(NUTRIENTS, null);
    }
    return [
        'name' => trim((string)($p['product_name'] ?? '')) ?: null,
        'brand' => trim(explode(',', (string)($p['brands'] ?? ''))[0]) ?: null,
        'pack_size' => $size,
        'unit' => $unit,
        'nutrition' => $nutrition,
        'has_nutrition' => count(array_filter($nutrition, fn($v) => $v !== null)) > 0,
    ];
}

/** "1 kg" → [1, 'kg'], "500g" → [500, 'g'], "6 x 1 l" → [6, 'l'] (total), else [1, 'each'] */
function parse_quantity(string $q): array
{
    $q = strtolower(str_replace(',', '.', $q));
    if (preg_match('/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/', $q, $m)) {
        return [(float)$m[1] * (float)$m[2], $m[3]];
    }
    if (preg_match('/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/', $q, $m)) {
        return [(float)$m[1], $m[2]];
    }
    if (preg_match('/(\d+(?:\.\d+)?)\s*cl\b/', $q, $m)) {
        return [(float)$m[1] * 10, 'ml'];
    }
    if (preg_match('/(\d+)\s*(pcs|pieces|eggs|units|pack|s\b)/', $q, $m)) {
        return [(float)$m[1], 'each'];
    }
    return [1.0, 'each'];
}

// ---------- request ----------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail('POST only', 405);
}
$user = current_user();
if (!$user) {
    fail('Not logged in', 401);
}
if (!hash_equals(csrf_token(), $_SERVER['HTTP_X_CSRF'] ?? '')) {
    fail('Session expired, reload the page', 419);
}
$in = json_decode(file_get_contents('php://input') ?: '{}', true);
if (!is_array($in)) {
    fail('Bad JSON');
}
$uid = (int)$user['id'];
$action = (string)($in['action'] ?? '');
run_migrations();

try {
    switch ($action) {

        case 'bootstrap':
            $month = date('Y-m');
            out([
                'user' => $user,
                'users' => q('SELECT id, display_name FROM users ORDER BY id')->fetchAll(),
                'stores' => q('SELECT id, name FROM stores ORDER BY name')->fetchAll(),
                'budget' => (float)setting('monthly_budget', '0'),
                'spent' => month_spent($month),
                'takeaway_weekly' => (float)setting('takeaway_weekly', '100'),
                'month' => $month,
                'currency' => config('currency', 'R'),
            ]);

        case 'logout':
            log_out();
            out(['ok' => true]);

        // ----- stores -----
        case 'stores.add':
            q('INSERT INTO stores (name) VALUES (?)', [str_in($in, 'name', 60, true)]);
            out(['id' => (int)db()->lastInsertId()]);

        case 'stores.rename':
            q('UPDATE stores SET name = ? WHERE id = ?', [str_in($in, 'name', 60, true), int_in($in, 'id')]);
            out(['ok' => true]);

        case 'stores.delete':
            q('DELETE FROM stores WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        // ----- products -----
        case 'products.list':
            $prices = latest_prices();
            $rows = array_map(fn($r) => product_row($r, $prices), q('SELECT * FROM products ORDER BY name')->fetchAll());
            out(['products' => $rows]);

        case 'products.lookup':
            $code = preg_replace('/\D/', '', (string)($in['barcode'] ?? ''));
            if ($code === '' || strlen($code) > 32) {
                fail('Invalid barcode');
            }
            $row = q('SELECT * FROM products WHERE barcode = ?', [$code])->fetch();
            if ($row) {
                out(['product' => product_row($row, latest_prices([(int)$row['id']])), 'suggestion' => null]);
            }
            out(['product' => null, 'suggestion' => off_lookup($code), 'barcode' => $code]);

        case 'products.off':
            // fetch Open Food Facts data for an existing product's barcode (e.g. to fill in nutrition later)
            $code = preg_replace('/\D/', '', (string)($in['barcode'] ?? ''));
            out(['suggestion' => $code === '' ? null : off_lookup($code)]);

        case 'products.save':
            $id = int_in($in, 'id', false);
            $unit = in_array($in['unit'] ?? null, UNITS, true) ? $in['unit'] : 'each';
            $barcode = preg_replace('/\D/', '', (string)($in['barcode'] ?? '')) ?: null;
            $fields = [
                'barcode' => $barcode,
                'name' => str_in($in, 'name', 120, true),
                'brand' => str_in($in, 'brand', 80),
                'pack_size' => num_in($in, 'pack_size', 1, 0.001, 100000),
                'unit' => $unit,
                'category' => str_in($in, 'category', 40),
            ];
            foreach (NUTRIENTS as $n) {
                $fields[$n] = num_in($in['nutrition'] ?? [], $n, null, 0, 100000);
            }
            if ($barcode !== null) {
                $dupe = q('SELECT id FROM products WHERE barcode = ? AND id <> ?', [$barcode, $id ?? 0])->fetchColumn();
                if ($dupe) {
                    fail('Another product already has that barcode');
                }
            }
            $cols = array_keys($fields);
            if ($id) {
                q('UPDATE products SET ' . implode(', ', array_map(fn($c) => "$c = ?", $cols)) . ' WHERE id = ?', [...array_values($fields), $id]);
            } else {
                q('INSERT INTO products (' . implode(', ', $cols) . ') VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')', array_values($fields));
                $id = (int)db()->lastInsertId();
            }
            foreach ((array)($in['prices'] ?? []) as $storeId => $price) {
                if ($price === '' || $price === null) {
                    continue;
                }
                if (!ctype_digit((string)$storeId) || !is_numeric($price) || $price < 0 || $price > 1e6) {
                    fail('Bad price');
                }
                record_price($id, (int)$storeId, (float)$price, $uid);
            }
            $row = q('SELECT * FROM products WHERE id = ?', [$id])->fetch();
            out(['product' => product_row($row, latest_prices([$id]))]);

        case 'products.price':
            record_price(int_in($in, 'product_id'), int_in($in, 'store_id'), num_in($in, 'price', null, 0, 1e6) ?? fail('Missing price'), $uid);
            out(['ok' => true]);

        case 'products.history':
            out(['history' => q('SELECT pr.price, pr.recorded_at, s.name store, u.display_name who
                                  FROM prices pr JOIN stores s ON s.id = pr.store_id LEFT JOIN users u ON u.id = pr.user_id
                                  WHERE pr.product_id = ? ORDER BY pr.id DESC LIMIT 50', [int_in($in, 'id')])->fetchAll()]);

        case 'products.delete':
            q('DELETE FROM products WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        // ----- shopping list -----
        case 'list.get':
            $items = q('SELECT li.*, u.display_name added_by_name, p.pack_size, p.unit, p.brand
                        FROM list_items li LEFT JOIN products p ON p.id = li.product_id LEFT JOIN users u ON u.id = li.added_by
                        ORDER BY li.checked, li.created_at, li.id')->fetchAll();
            $prices = latest_prices(array_values(array_filter(array_map(fn($i) => $i['product_id'] === null ? null : (int)$i['product_id'], $items))));
            foreach ($items as &$i) {
                $i['id'] = (int)$i['id'];
                $i['product_id'] = $i['product_id'] === null ? null : (int)$i['product_id'];
                $i['qty'] = (float)$i['qty'];
                $i['unit_price'] = $i['unit_price'] === null ? null : (float)$i['unit_price'];
                $i['checked'] = (bool)$i['checked'];
                $i['from_plan'] = (bool)$i['from_plan'];
                $i['pack_size'] = $i['pack_size'] === null ? null : (float)$i['pack_size'];
                $i['prices'] = (object)($i['product_id'] ? ($prices[$i['product_id']] ?? []) : []);
            }
            unset($i);
            $lastShop = q("SELECT MAX(trip_date) FROM trips WHERE kind = 'groceries'")->fetchColumn();
            out([
                'items' => $items,
                'spent' => month_spent(date('Y-m')),
                'budget' => (float)setting('monthly_budget', '0'),
                'takeaway' => takeaway_week(),
                'fridge' => fridge_list(),
                'last_shop' => $lastShop ?: null,
            ]);

        case 'list.add':
            $pid = int_in($in, 'product_id', false);
            $qty = num_in($in, 'qty', 1, 0.01, 1000);
            if ($pid) {
                $name = q('SELECT name FROM products WHERE id = ?', [$pid])->fetchColumn();
                if ($name === false) {
                    fail('Unknown product');
                }
                $existing = q('SELECT id FROM list_items WHERE product_id = ? AND checked = 0 AND from_plan = 0 LIMIT 1', [$pid])->fetchColumn();
                if ($existing) {
                    q('UPDATE list_items SET qty = qty + ? WHERE id = ?', [$qty, $existing]);
                    out(['id' => (int)$existing]);
                }
            } else {
                $name = str_in($in, 'name', 120, true);
            }
            q('INSERT INTO list_items (product_id, name, qty, unit_price, added_by) VALUES (?, ?, ?, ?, ?)',
                [$pid, $name, $qty, $pid ? null : num_in($in, 'unit_price', null, 0, 1e6), $uid]);
            out(['id' => (int)db()->lastInsertId()]);

        case 'list.update':
            $id = int_in($in, 'id');
            $item = q('SELECT * FROM list_items WHERE id = ?', [$id])->fetch() ?: fail('Item not found', 404);
            if (array_key_exists('qty', $in)) {
                q('UPDATE list_items SET qty = ? WHERE id = ?', [num_in($in, 'qty', 1, 0.01, 1000), $id]);
            }
            if (array_key_exists('checked', $in)) {
                q('UPDATE list_items SET checked = ? WHERE id = ?', [$in['checked'] ? 1 : 0, $id]);
            }
            if (array_key_exists('name', $in) && $item['product_id'] === null) {
                q('UPDATE list_items SET name = ? WHERE id = ?', [str_in($in, 'name', 120, true), $id]);
            }
            if (array_key_exists('price', $in)) {
                $price = num_in($in, 'price', null, 0, 1e6);
                $storeId = int_in($in, 'store_id', false);
                if ($item['product_id'] !== null && $storeId && $price !== null) {
                    record_price((int)$item['product_id'], $storeId, $price, $uid);   // teaches the product its price at this shop
                } else {
                    q('UPDATE list_items SET unit_price = ? WHERE id = ?', [$price, $id]);
                }
            }
            out(['ok' => true]);

        case 'list.delete':
            q('DELETE FROM list_items WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        case 'list.clear':
            q(!empty($in['all']) ? 'DELETE FROM list_items' : 'DELETE FROM list_items WHERE checked = 1');
            out(['ok' => true]);

        case 'list.checkout':
            $storeId = int_in($in, 'store_id', false);
            $date = date_in($in, 'date', date('Y-m-d'));
            $items = q('SELECT * FROM list_items WHERE checked = 1')->fetchAll();
            if (!$items) {
                fail('Tick off what you bought first');
            }
            $prices = latest_prices(array_values(array_filter(array_map(fn($i) => $i['product_id'] === null ? null : (int)$i['product_id'], $items))));
            $estimate = 0.0;
            foreach ($items as $i) {
                $p = $i['unit_price'] !== null ? (float)$i['unit_price']
                    : ($i['product_id'] ? ($prices[(int)$i['product_id']][$storeId ?? 0]['price'] ?? best_price($prices[(int)$i['product_id']] ?? [])) : null);
                $estimate += (float)$i['qty'] * (float)($p ?? 0);
            }
            $total = num_in($in, 'total', round($estimate, 2), 0, 1e6);
            db()->beginTransaction();
            q('INSERT INTO trips (trip_date, store_id, total, note, user_id) VALUES (?, ?, ?, ?, ?)',
                [$date, $storeId, $total, str_in($in, 'note', 200), $uid]);
            q('DELETE FROM list_items WHERE checked = 1');
            db()->commit();
            out(['total' => $total, 'spent' => month_spent(substr($date, 0, 7))]);

        // ----- recipes -----
        case 'recipes.list':
            out(['recipes' => recipes_with_costs()]);

        case 'recipes.save':
            $id = int_in($in, 'id', false);
            $name = str_in($in, 'name', 120, true);
            $servings = (int)num_in($in, 'servings', 1, 1, 100);
            $instructions = isset($in['instructions']) && trim((string)$in['instructions']) !== '' ? mb_substr((string)$in['instructions'], 0, 20000) : null;
            $prep = num_in($in, 'prep_minutes', null, 0, 10000);
            $cook = num_in($in, 'cook_minutes', null, 0, 10000);
            $vals = [$name, $servings, $instructions, $prep === null ? null : (int)$prep, $cook === null ? null : (int)$cook];
            db()->beginTransaction();
            if ($id) {
                q('UPDATE recipes SET name = ?, servings = ?, instructions = ?, prep_minutes = ?, cook_minutes = ? WHERE id = ?', [...$vals, $id]);
                q('DELETE FROM recipe_items WHERE recipe_id = ?', [$id]);
                q('DELETE FROM recipe_steps WHERE recipe_id = ?', [$id]);
            } else {
                q('INSERT INTO recipes (name, servings, instructions, prep_minutes, cook_minutes) VALUES (?, ?, ?, ?, ?)', $vals);
                $id = (int)db()->lastInsertId();
            }
            foreach (array_values((array)($in['items'] ?? [])) as $i => $it) {
                $it = (array)$it;
                $pid = int_in($it, 'product_id');
                $amount = num_in($it, 'amount', null, 0.001, 100000);
                if ($amount === null) {
                    continue;
                }
                q('INSERT INTO recipe_items (recipe_id, product_id, amount, note, sort) VALUES (?, ?, ?, ?, ?)', [$id, $pid, $amount, str_in($it, 'note', 120), $i]);
            }
            foreach (array_values((array)($in['steps'] ?? [])) as $i => $st) {
                $st = (array)$st;
                $body = isset($st['body']) ? trim(mb_substr((string)$st['body'], 0, 4000)) : '';
                if ($body === '') {
                    continue;
                }
                $timer = num_in($st, 'timer_minutes', null, 0, 1440);
                q('INSERT INTO recipe_steps (recipe_id, sort, body, timer_minutes) VALUES (?, ?, ?, ?)', [$id, $i, $body, $timer ? (int)$timer : null]);
            }
            db()->commit();
            out(['recipe' => recipes_with_costs($id)[0]]);

        case 'recipes.delete':
            q('DELETE FROM recipes WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        case 'recipes.to_list':
            // add the packs needed for one batch of a recipe at a chosen number of portions
            $rid = int_in($in, 'id');
            $portions = num_in($in, 'portions', null, 0.25, 500) ?? fail('Missing portions');
            $need = q('SELECT ri.product_id, p.name, p.pack_size, ri.amount * ? / r.servings amount
                       FROM recipe_items ri JOIN recipes r ON r.id = ri.recipe_id JOIN products p ON p.id = ri.product_id
                       WHERE r.id = ?', [$portions, $rid])->fetchAll();
            $added = 0;
            foreach ($need as $n) {
                $packs = max(1, (int)ceil((float)$n['amount'] / max(0.001, (float)$n['pack_size']) - 1e-6));
                $existing = q('SELECT id FROM list_items WHERE product_id = ? AND checked = 0 AND from_plan = 0 LIMIT 1', [$n['product_id']])->fetchColumn();
                if ($existing) {
                    q('UPDATE list_items SET qty = qty + ? WHERE id = ?', [$packs, $existing]);
                } else {
                    q('INSERT INTO list_items (product_id, name, qty, added_by) VALUES (?, ?, ?, ?)', [$n['product_id'], $n['name'], $packs, $uid]);
                }
                $added++;
            }
            out(['added' => $added]);

        // ----- fridge (cooked portions) -----
        case 'fridge.list':
            out(['fridge' => fridge_list()]);

        case 'fridge.cook':
            $rid = int_in($in, 'recipe_id', false);
            $name = str_in($in, 'name', 120);
            $cpp = null;
            if ($rid) {
                $rec = recipes_with_costs($rid)[0] ?? fail('Recipe not found', 404);
                $name = $rec['name'];
                $cpp = $rec['missing_prices'] ? null : $rec['cost_per_serving'];
            }
            if ($name === null) {
                fail('Pick a recipe or type a name');
            }
            $grams = num_in($in, 'grams_per_portion', null, 1, 100000);
            q('INSERT INTO fridge (recipe_id, name, portions, grams_per_portion, cost_per_portion, cooked_on, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [
                $rid, $name, num_in($in, 'portions', null, 0.25, 500) ?? fail('How many portions?'),
                $grams === null ? null : (int)round($grams), $cpp, date_in($in, 'date', date('Y-m-d')), $uid,
            ]);
            out(['fridge' => fridge_list()]);

        case 'fridge.eat':
            q('UPDATE fridge SET portions = GREATEST(0, portions - ?) WHERE id = ?', [num_in($in, 'n', 1, 0.25, 500), int_in($in, 'id')]);
            q('DELETE FROM fridge WHERE portions <= 0');
            out(['fridge' => fridge_list()]);

        case 'fridge.set':
            q('UPDATE fridge SET portions = ? WHERE id = ?', [num_in($in, 'portions', null, 0, 500) ?? fail('Missing portions'), int_in($in, 'id')]);
            q('DELETE FROM fridge WHERE portions <= 0');
            out(['fridge' => fridge_list()]);

        case 'fridge.delete':
            q('DELETE FROM fridge WHERE id = ?', [int_in($in, 'id')]);
            out(['fridge' => fridge_list()]);

        // ----- takeaways -----
        case 'takeaway.get':
            out(['takeaway' => takeaway_week()]);

        case 'takeaway.add':
            q("INSERT INTO trips (trip_date, store_id, total, note, user_id, kind) VALUES (?, NULL, ?, ?, ?, 'eating_out')", [
                date_in($in, 'date', date('Y-m-d')),
                num_in($in, 'total', null, 0, 1e5) ?? fail('How much was it?'),
                str_in($in, 'note', 200), $uid,
            ]);
            out(['takeaway' => takeaway_week()]);

        case 'takeaway.set':
            set_setting('takeaway_weekly', number_format(num_in($in, 'weekly', 0, 0, 1e6), 2, '.', ''));
            out(['takeaway' => takeaway_week()]);

        // ----- meal plan -----
        case 'plan.get':
            $from = date_in($in, 'from');
            $to = date_in($in, 'to');
            $recipes = [];
            foreach (recipes_with_costs() as $r) {
                $recipes[$r['id']] = $r;
            }
            $rows = q('SELECT * FROM plan WHERE plan_date BETWEEN ? AND ? ORDER BY plan_date, FIELD(slot, \'breakfast\', \'lunch\', \'dinner\', \'snack\'), id', [$from, $to])->fetchAll();
            $entries = [];
            foreach ($rows as $r) {
                $rec = $recipes[(int)$r['recipe_id']] ?? null;
                if (!$rec) {
                    continue;
                }
                $s = (float)$r['servings'];
                $entries[] = [
                    'id' => (int)$r['id'],
                    'date' => $r['plan_date'],
                    'slot' => $r['slot'],
                    'recipe_id' => $rec['id'],
                    'recipe' => $rec['name'],
                    'servings' => $s,
                    'cost' => round($rec['cost_per_serving'] * $s, 2),
                    'energy_kj' => round((float)$rec['nutrition_per_serving']['energy_kj'] * $s),
                    'protein_g' => round((float)$rec['nutrition_per_serving']['protein_g'] * $s, 1),
                ];
            }
            out(['entries' => $entries]);

        case 'plan.set':
            $slot = in_array($in['slot'] ?? '', SLOTS, true) ? $in['slot'] : fail('Bad slot');
            $id = int_in($in, 'id', false);
            $vals = [date_in($in, 'date'), $slot, int_in($in, 'recipe_id'), num_in($in, 'servings', 1, 0.25, 50)];
            if ($id) {
                q('UPDATE plan SET plan_date = ?, slot = ?, recipe_id = ?, servings = ? WHERE id = ?', [...$vals, $id]);
            } else {
                q('INSERT INTO plan (plan_date, slot, recipe_id, servings) VALUES (?, ?, ?, ?)', $vals);
            }
            out(['ok' => true]);

        case 'plan.delete':
            q('DELETE FROM plan WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        case 'plan.copy_week':
            // copy one week's plan onto the following week
            $from = date_in($in, 'from');
            $rows = q('SELECT * FROM plan WHERE plan_date BETWEEN ? AND DATE_ADD(?, INTERVAL 6 DAY)', [$from, $from])->fetchAll();
            foreach ($rows as $r) {
                q('INSERT INTO plan (plan_date, slot, recipe_id, servings) VALUES (DATE_ADD(?, INTERVAL 7 DAY), ?, ?, ?)',
                    [$r['plan_date'], $r['slot'], $r['recipe_id'], $r['servings']]);
            }
            out(['copied' => count($rows)]);

        case 'plan.to_list':
            $from = date_in($in, 'from');
            $to = date_in($in, 'to');
            $need = q('SELECT ri.product_id, p.name, p.pack_size, SUM(ri.amount * pl.servings / r.servings) amount
                       FROM plan pl JOIN recipes r ON r.id = pl.recipe_id
                       JOIN recipe_items ri ON ri.recipe_id = r.id JOIN products p ON p.id = ri.product_id
                       WHERE pl.plan_date BETWEEN ? AND ? GROUP BY ri.product_id, p.name, p.pack_size', [$from, $to])->fetchAll();
            db()->beginTransaction();
            q('DELETE FROM list_items WHERE from_plan = 1 AND checked = 0');
            $added = 0;
            foreach ($need as $n) {
                $packs = max(1, (int)ceil((float)$n['amount'] / max(0.001, (float)$n['pack_size']) - 1e-6));
                q('INSERT INTO list_items (product_id, name, qty, from_plan, added_by) VALUES (?, ?, ?, 1, ?)', [$n['product_id'], $n['name'], $packs, $uid]);
                $added++;
            }
            db()->commit();
            out(['added' => $added]);

        // ----- budget / trips -----
        case 'budget.get':
            $month = preg_match('/^\d{4}-\d{2}$/', (string)($in['month'] ?? '')) ? $in['month'] : date('Y-m');
            $trips = q('SELECT t.id, t.trip_date, t.total, t.note, t.kind, s.name store, u.display_name who
                        FROM trips t LEFT JOIN stores s ON s.id = t.store_id LEFT JOIN users u ON u.id = t.user_id
                        WHERE DATE_FORMAT(t.trip_date, \'%Y-%m\') = ? ORDER BY t.trip_date DESC, t.id DESC', [$month])->fetchAll();
            foreach ($trips as &$t) {
                $t['total'] = (float)$t['total'];
            }
            unset($t);
            out([
                'month' => $month,
                'budget' => (float)setting('monthly_budget', '0'),
                'spent' => month_spent($month),
                'eating_out' => month_spent($month, 'eating_out'),
                'takeaway_weekly' => (float)setting('takeaway_weekly', '100'),
                'trips' => $trips,
            ]);

        case 'budget.set':
            set_setting('monthly_budget', number_format(num_in($in, 'monthly_budget', 0, 0, 1e7), 2, '.', ''));
            out(['ok' => true]);

        case 'trips.add':
            q('INSERT INTO trips (trip_date, store_id, total, note, user_id) VALUES (?, ?, ?, ?, ?)', [
                date_in($in, 'date', date('Y-m-d')), int_in($in, 'store_id', false),
                num_in($in, 'total', null, 0, 1e6) ?? fail('Missing total'), str_in($in, 'note', 200), $uid,
            ]);
            out(['ok' => true]);

        case 'trips.delete':
            q('DELETE FROM trips WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        case 'account.password':
            $row = q('SELECT password_hash FROM users WHERE id = ?', [$uid])->fetch();
            if (!password_verify((string)($in['current'] ?? ''), $row['password_hash'])) {
                fail('Current password is wrong');
            }
            if (strlen((string)($in['new'] ?? '')) < 8) {
                fail('New password must be at least 8 characters');
            }
            q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash((string)$in['new'], PASSWORD_DEFAULT), $uid]);
            q('DELETE FROM auth_tokens WHERE user_id = ?', [$uid]);
            out(['ok' => true]);

        default:
            fail('Unknown action', 404);
    }
} catch (PDOException $e) {
    if (db()->inTransaction()) {
        db()->rollBack();
    }
    error_log('KitchenBudget: ' . $e->getMessage());
    fail($e->getCode() === '23000' ? 'That already exists or is still in use' : 'Database error', 500);
} catch (Throwable $e) {
    if (db()->inTransaction()) {
        db()->rollBack();
    }
    error_log('KitchenBudget: ' . $e->getMessage());
    fail('Server error', 500);
}
