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

$OP_ID = null;

function out($data, int $code = 200): never
{
    global $OP_ID;
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($OP_ID !== null && $code === 200) {
        // remember the answer so a replay of this change (sent again after a dropped connection) isn't applied twice
        q('INSERT IGNORE INTO op_log (op_id, response) VALUES (?, ?)', [$OP_ID, $json]);
    }
    http_response_code($code);
    echo $json;
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
    // only this person's shops, so prices and 'cheapest' are their own
    $sql = 'SELECT p.product_id, p.store_id, p.price, p.recorded_at FROM prices p
            JOIN (SELECT MAX(pr.id) id FROM prices pr JOIN stores s ON s.id = pr.store_id AND s.user_id = ' . kid() . ' GROUP BY pr.product_id, pr.store_id) m ON m.id = p.id';
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

/** A recipe this person may use (theirs, shared, or in their plan/fridge). */
function can_see_recipe(int $id): bool
{
    return (bool)recipes_with_costs($id);
}

/** A recipe this person owns (only the owner edits, shares or deletes it). */
function own_recipe(int $id): void
{
    if (!q('SELECT 1 FROM recipes WHERE id = ? AND user_id = ?', [$id, me()])->fetchColumn()) {
        fail("Only the person who added this recipe can change it. Make a copy to change yours.", 403);
    }
}

/** The logged-in person: their recipes, takeaways, alerts and targets. */
function me(): int
{
    return (int)$GLOBALS['uid'];
}

/**
 * Whose kitchen this request works on (list, pantry, shops and prices, plan, fridge, groceries budget).
 * That's you, unless your household runs a shared kitchen: then it's the household's hidden kitchen account.
 */
function kid(): int
{
    return (int)($GLOBALS['kid'] ?? $GLOBALS['uid']);
}

/** Settings that belong to the kitchen; everything else (takeaway allowance…) stays personal. */
const KITCHEN_SETTINGS = ['monthly_budget', 'payday', 'aisle_order'];

/** Your household and your role in it, or null. */
function my_household(int $uid): ?array
{
    $h = q('SELECT h.*, m.role FROM household_members m JOIN households h ON h.id = m.household_id WHERE m.user_id = ?', [$uid])->fetch();
    return $h ?: null;
}

function kitchen_of(int $uid): int
{
    $h = my_household($uid);
    return $h && $h['mode'] === 'shared' ? (int)$h['kitchen_user_id'] : $uid;
}

/** People in your household (you included), for recipe sharing. */
function household_people(int $uid): array
{
    return array_map('intval', q('SELECT m2.user_id FROM household_members m1 JOIN household_members m2 ON m2.household_id = m1.household_id WHERE m1.user_id = ?', [$uid])->fetchAll(PDO::FETCH_COLUMN));
}

function household_view(int $uid): ?array
{
    $h = my_household($uid);
    if (!$h) {
        return null;
    }
    return [
        'id' => (int)$h['id'],
        'name' => $h['name'],
        'mode' => $h['mode'],
        'role' => $h['role'],
        'members' => array_map(fn($m) => ['id' => (int)$m['id'], 'display_name' => $m['display_name'], 'role' => $m['role'], 'joined_at' => $m['joined_at']],
            q('SELECT u.id, u.display_name, m.role, m.joined_at FROM household_members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.joined_at, u.id', [$h['id']])->fetchAll()),
    ];
}

/** Leave your household. The last one out closes it (and its shared kitchen); an owner leaving hands over to the longest member. */
function leave_household(int $uid): void
{
    $h = my_household($uid);
    if (!$h) {
        return;
    }
    q('DELETE FROM household_members WHERE user_id = ?', [$uid]);
    $left = q('SELECT user_id FROM household_members WHERE household_id = ? ORDER BY joined_at, user_id', [$h['id']])->fetchAll(PDO::FETCH_COLUMN);
    if (!$left) {
        q('DELETE FROM users WHERE id = ? AND is_kitchen = 1', [$h['kitchen_user_id']]);   // cascades to the household and its kitchen
    } elseif ($h['role'] === 'owner') {
        q("UPDATE household_members SET role = 'owner' WHERE user_id = ?", [$left[0]]);
    }
}

/** The first time a household shares its kitchen, it starts as a copy of the kitchen of whoever switched it on. */
function seed_kitchen(int $from, int $to): void
{
    if (q('SELECT 1 FROM stores WHERE user_id = ? LIMIT 1', [$to])->fetchColumn()) {
        return;
    }
    foreach (q('SELECT id, name FROM stores WHERE user_id = ?', [$from])->fetchAll() as $st) {
        q('INSERT INTO stores (user_id, name) VALUES (?, ?)', [$to, $st['name']]);
        $new = (int)db()->lastInsertId();
        // the latest price of each product at this shop, so the shared kitchen already knows what things cost
        q('INSERT INTO prices (product_id, store_id, price, user_id, recorded_at)
           SELECT p.product_id, ?, p.price, p.user_id, p.recorded_at FROM prices p
           JOIN (SELECT MAX(id) id FROM prices WHERE store_id = ? GROUP BY product_id) m ON m.id = p.id', [$new, $st['id']]);
    }
    q('INSERT INTO pantry (user_id, product_id, amount, bought_count, last_bought) SELECT ?, product_id, amount, bought_count, last_bought FROM pantry WHERE user_id = ?', [$to, $from]);
    q('INSERT INTO list_items (user_id, product_id, name, qty, unit_price, checked, from_plan, added_by)
       SELECT ?, product_id, name, qty, unit_price, 0, from_plan, added_by FROM list_items WHERE user_id = ? AND checked = 0', [$to, $from]);
    q('INSERT INTO plan (user_id, plan_date, slot, recipe_id, servings, eaten_at, fridge_taken)
       SELECT ?, plan_date, slot, recipe_id, servings, eaten_at, fridge_taken FROM plan WHERE user_id = ? AND plan_date >= CURDATE()', [$to, $from]);
    q('INSERT INTO fridge (recipe_id, name, portions, grams_per_portion, cost_per_portion, cooked_on, user_id, location, moved_on)
       SELECT recipe_id, name, portions, grams_per_portion, cost_per_portion, cooked_on, ?, location, moved_on FROM fridge WHERE user_id = ? AND portions > 0', [$to, $from]);
    q("INSERT INTO user_settings (user_id, k, v) SELECT ?, k, v FROM user_settings WHERE user_id = ? AND k IN ('monthly_budget', 'payday', 'aisle_order')", [$to, $from]);
    q('INSERT IGNORE INTO pay_dates (user_id, paid_on) SELECT ?, paid_on FROM pay_dates WHERE user_id = ?', [$to, $from]);
}

/** An invite token from the request: valid, unused, not expired. */
function invite_row(string $tok): array
{
    preg_match('/^[0-9a-f]{48}$/', $tok) || fail('That invite link is broken');
    $row = q('SELECT i.*, h.name household, u.display_name inviter FROM household_invites i JOIN households h ON h.id = i.household_id
              LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?', [hash('sha256', $tok)])->fetch();
    if (!$row || $row['used_at'] !== null || strtotime($row['expires_at']) < time()) {
        fail('That invite link has been used or has expired. Ask for a new one.', 410);
    }
    return $row;
}

/** A shop id from the request, only if it's one of this person's shops. */
function own_store(?int $id): ?int
{
    if ($id === null) {
        return null;
    }
    if (!q('SELECT 1 FROM stores WHERE id = ? AND user_id = ?', [$id, kid()])->fetchColumn()) {
        fail('Unknown shop');
    }
    return $id;
}

function user_setting(string $key, string $default = ''): string
{
    $v = q('SELECT v FROM user_settings WHERE user_id = ? AND k = ?', [in_array($key, KITCHEN_SETTINGS, true) ? kid() : me(), $key])->fetchColumn();
    return $v === false ? $default : (string)$v;
}

function set_user_setting(string $key, string $value): void
{
    q('INSERT INTO user_settings (user_id, k, v) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [in_array($key, KITCHEN_SETTINGS, true) ? kid() : me(), $key, $value]);
}

const DEFAULT_STORES = ['Checkers', 'Pick n Pay', 'Shoprite'];
const DEFAULT_AISLES = '["Fresh produce","Meat & fish","Dairy & eggs","Bakery","Pantry","Frozen","Household"]';

function record_price(int $productId, int $storeId, float $price, int $userId): void
{
    own_store($storeId);
    $last = q('SELECT price FROM prices WHERE product_id = ? AND store_id = ? ORDER BY id DESC LIMIT 1', [$productId, $storeId])->fetchColumn();
    if ($last === false || abs((float)$last - $price) > 0.004) {
        q('INSERT INTO prices (product_id, store_id, price, user_id) VALUES (?, ?, ?, ?)', [$productId, $storeId, $price, $userId]);
    }
}

/** product_id => amount at home (in the product's unit) */
function pantry_map(): array
{
    $m = [];
    foreach (q('SELECT product_id, amount FROM pantry WHERE user_id = ? AND amount > 0', [kid()]) as $r) {
        $m[(int)$r['product_id']] = (float)$r['amount'];
    }
    return $m;
}

function pantry_add(int $productId, float $delta): void
{
    q('INSERT INTO pantry (user_id, product_id, amount) VALUES (?, ?, GREATEST(0, ?)) ON DUPLICATE KEY UPDATE amount = GREATEST(0, amount + ?)', [kid(), $productId, $delta, $delta]);
}

/**
 * Turn [product_id => amount needed] into list items: subtract what's at home, round up to whole packs.
 * Returns how many lines were added.
 */
function need_to_list(array $need, int $uid, bool $fromPlan): int
{
    if (!$need) {
        return 0;
    }
    $pantry = pantry_map();
    $prods = [];
    foreach (q('SELECT id, name, pack_size FROM products WHERE id IN (' . implode(',', array_fill(0, count($need), '?')) . ')', array_keys($need)) as $p) {
        $prods[(int)$p['id']] = $p;
    }
    $added = 0;
    foreach ($need as $pid => $amount) {
        $p = $prods[$pid] ?? null;
        if (!$p) {
            continue;
        }
        $short = $amount - ($pantry[$pid] ?? 0);
        if ($short <= 1e-6) {
            continue;   // enough at home
        }
        $packs = max(1, (int)ceil($short / max(0.001, (float)$p['pack_size']) - 1e-6));
        $existing = $fromPlan ? false
            : q('SELECT id FROM list_items WHERE user_id = ? AND product_id = ? AND checked = 0 AND from_plan = 0 LIMIT 1', [kid(), $pid])->fetchColumn();
        if ($existing) {
            q('UPDATE list_items SET qty = qty + ? WHERE id = ?', [$packs, $existing]);
        } else {
            q('INSERT INTO list_items (user_id, product_id, name, qty, from_plan, added_by) VALUES (?, ?, ?, ?, ?, ?)', [kid(), $pid, $p['name'], $packs, $fromPlan ? 1 : 0, $uid]);
        }
        $added++;
    }
    return $added;
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
    $r['pantry'] = isset($r['pantry']) && $r['pantry'] !== null ? (float)$r['pantry'] : 0.0;
    $r['bought_count'] = (int)($r['bought_count'] ?? 0);
    $r['nova'] = isset($r['nova']) && $r['nova'] !== null ? (int)$r['nova'] : null;
    $r['additives'] = !empty($r['additives']) ? explode(',', $r['additives']) : [];
    unset($r['created_at'], $r['off_checked_at']);
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
    // yours, your household's, shared ones, and any in your kitchen's plan or fridge (so a recipe someone unshares doesn't vanish from your week)
    $people = household_people(me()) ?: [me()];
    $in = implode(',', array_map('intval', $people));
    $visible = "(r.user_id IN ($in) OR r.is_public = 1 OR r.id IN (SELECT recipe_id FROM plan WHERE user_id = ?) OR r.id IN (SELECT recipe_id FROM fridge WHERE user_id = ? AND recipe_id IS NOT NULL))";
    $recipes = $onlyId === null
        ? q("SELECT r.*, u.display_name owner_name FROM recipes r LEFT JOIN users u ON u.id = r.user_id WHERE $visible ORDER BY r.name", [kid(), kid()])->fetchAll()
        : q("SELECT r.*, u.display_name owner_name FROM recipes r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND $visible", [$onlyId, kid(), kid()])->fetchAll();
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
            'mine' => (int)$r['user_id'] === me(),
            'household' => (int)$r['user_id'] !== me() && in_array((int)$r['user_id'], $people, true),
            'is_public' => (int)$r['is_public'] === 1,
            'owner_name' => $r['owner_name'] ?? null,
        ];
    }
    return $result;
}

/**
 * The pay period containing $date: from the latest payday on or before it to the day before the next one.
 * Paydays are the usual day of the month (user setting 'payday', default the 1st), except where a marked
 * pay date falls within 10 days of it (early December pay, a moved payday): the marked date wins.
 */
function pay_period(?string $date = null): array
{
    $d = new DateTimeImmutable($date ?? 'today');
    $day = max(1, min(31, (int)user_setting('payday', '1')));
    $marks = q('SELECT paid_on FROM pay_dates WHERE user_id = ? AND paid_on BETWEEN ? AND ?', [
        kid(), $d->modify('-100 days')->format('Y-m-d'), $d->modify('+100 days')->format('Y-m-d'),
    ])->fetchAll(PDO::FETCH_COLUMN);
    $starts = $marks;
    for ($i = -3; $i <= 3; $i++) {
        $m = $d->modify(sprintf('first day of %+d month', $i));
        $usual = $m->setDate((int)$m->format('Y'), (int)$m->format('n'), min($day, (int)$m->format('t')));
        $replaced = false;
        foreach ($marks as $mk) {
            if (abs((new DateTimeImmutable($mk))->getTimestamp() - $usual->getTimestamp()) <= 10 * 86400) {
                $replaced = true;
            }
        }
        if (!$replaced) {
            $starts[] = $usual->format('Y-m-d');
        }
    }
    $starts = array_values(array_unique($starts));
    sort($starts);
    $key = $d->format('Y-m-d');
    $start = null;
    $next = null;
    foreach ($starts as $st) {
        if ($st <= $key) {
            $start = $st;
        } elseif ($next === null) {
            $next = $st;
        }
    }
    $s = new DateTimeImmutable($start);
    $e = (new DateTimeImmutable($next))->modify('-1 day');
    $today = new DateTimeImmutable('today');
    $wholeMonth = $s->format('j') === '1' && $e->format('j') === $e->format('t') && $s->format('Y-m') === $e->format('Y-m');
    return [
        'start' => $s->format('Y-m-d'),
        'end' => $e->format('Y-m-d'),
        'label' => $wholeMonth ? $s->format('F Y') : $s->format('j M') . ' – ' . $e->format('j M Y'),
        'current' => $today >= $s && $today <= $e,
        'days_left' => $today >= $s && $today <= $e ? (int)$today->diff($e)->days + 1 : 0,
    ];
}

/** code => 'always' | 'never' for the logged-in person */
function alert_prefs(): array|stdClass
{
    $out = [];
    foreach (q('SELECT code, mode FROM ingredient_alerts WHERE user_id = ? ORDER BY created_at', [me()]) as $r) {
        $out[$r['code']] = $r['mode'];
    }
    return $out ?: new stdClass();   // {} in JSON when empty
}

function period_spent(array $period, string $kind = 'groceries'): float
{
    return (float)q('SELECT COALESCE(SUM(total), 0) FROM trips WHERE user_id = ? AND kind = ? AND trip_date BETWEEN ? AND ?',
        [$kind === 'groceries' ? kid() : me(), $kind, $period['start'], $period['end']])->fetchColumn();
}

function month_spent(string $month, string $kind = 'groceries'): float
{
    return (float)q("SELECT COALESCE(SUM(total), 0) FROM trips WHERE user_id = ? AND kind = ? AND DATE_FORMAT(trip_date, '%Y-%m') = ?", [$kind === 'groceries' ? kid() : me(), $kind, $month])->fetchColumn();
}

/** Takeaway spend for the Monday-to-Sunday week containing $date, against the weekly allowance. */
function takeaway_week(?string $date = null): array
{
    $d = new DateTimeImmutable($date ?? 'today');
    $monday = $d->modify('-' . ((int)$d->format('N') - 1) . ' days');
    $sunday = $monday->modify('+6 days');
    $rows = q("SELECT id, trip_date, total, note FROM trips WHERE user_id = ? AND kind = 'eating_out' AND trip_date BETWEEN ? AND ? ORDER BY trip_date DESC, id DESC",
        [me(), $monday->format('Y-m-d'), $sunday->format('Y-m-d')])->fetchAll();
    $spent = 0.0;
    foreach ($rows as &$r) {
        $r['id'] = (int)$r['id'];
        $r['total'] = (float)$r['total'];
        $spent += $r['total'];
    }
    unset($r);
    return [
        'weekly' => (float)user_setting('takeaway_weekly', '100'),
        'spent' => round($spent, 2),
        'from' => $monday->format('Y-m-d'),
        'to' => $sunday->format('Y-m-d'),
        'items' => $rows,
    ];
}

function plan_entries(string $from, string $to): array
{
    $recipes = [];
    foreach (recipes_with_costs() as $r) {
        $recipes[$r['id']] = $r;
    }
    $rows = q("SELECT * FROM plan WHERE user_id = ? AND plan_date BETWEEN ? AND ? ORDER BY plan_date, FIELD(slot, 'breakfast', 'lunch', 'dinner', 'snack'), id", [kid(), $from, $to])->fetchAll();
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
            'eaten' => $r['eaten_at'] !== null,
            'cost' => round($rec['cost_per_serving'] * $s, 2),
            'energy_kj' => round((float)$rec['nutrition_per_serving']['energy_kj'] * $s),
            'protein_g' => round((float)$rec['nutrition_per_serving']['protein_g'] * $s, 1),
        ];
    }
    return $entries;
}

function fridge_list(): array
{
    $rows = q("SELECT f.*, r.servings FROM fridge f LEFT JOIN recipes r ON r.id = f.recipe_id WHERE f.user_id = ? AND f.portions > 0 ORDER BY f.location = 'freezer', f.cooked_on, f.id", [kid()])->fetchAll();
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
            'location' => $r['location'],
            'moved_on' => $r['moved_on'],
            // fridge: 3 days from cooking, or 2 days from thawing; freezer: 3 months
            'use_by' => $r['location'] === 'freezer'
                ? (new DateTimeImmutable($r['moved_on'] ?? $r['cooked_on']))->modify('+90 days')->format('Y-m-d')
                : ($r['moved_on'] ? (new DateTimeImmutable($r['moved_on']))->modify('+2 days')->format('Y-m-d')
                    : (new DateTimeImmutable($r['cooked_on']))->modify('+3 days')->format('Y-m-d')),
        ];
        $last = count($out) - 1;
        $out[$last]['days_left'] = (int)$today->diff(new DateTimeImmutable($out[$last]['use_by']))->format('%r%a');
    }
    return $out;
}

/** ['e330', 'E 211', ...] -> ['e211', 'e330'] (unique, lower case, max 40) */
function clean_additives(array $list): array
{
    $out = [];
    foreach ($list as $a) {
        $a = strtolower(preg_replace('/\s+/', '', (string)$a));
        if (preg_match('/^e\d{3,4}[a-z]?$/', $a)) {
            $out[$a] = true;
        }
    }
    $out = array_keys($out);
    sort($out);
    return array_slice($out, 0, 40);
}

/** E-numbers mentioned in an ingredient list. */
function additives_in(?string $ingredients): array
{
    if (!$ingredients) {
        return [];
    }
    preg_match_all('/\bE\s?-?\s?(\d{3,4}[a-z]?)\b/i', $ingredients, $m);
    return clean_additives(array_map(fn($x) => 'e' . $x, $m[1]));
}

/** Store Open Food Facts health info on a product; fill nutrition only where it's still empty. */
function apply_off(int $id, ?array $s): void
{
    if (!$s) {
        q('UPDATE products SET off_checked_at = NOW() WHERE id = ?', [$id]);
        return;
    }
    $cur = q('SELECT * FROM products WHERE id = ?', [$id])->fetch();
    $set = ['off_checked_at = NOW()'];
    $vals = [];
    foreach (['nutriscore', 'nova'] as $k) {
        if ($s[$k] !== null) { $set[] = "$k = ?"; $vals[] = $s[$k]; }
    }
    if ($s['additives']) { $set[] = 'additives = ?'; $vals[] = implode(',', $s['additives']); }
    if ($s['ingredients'] && empty($cur['ingredients'])) { $set[] = 'ingredients = ?'; $vals[] = mb_substr($s['ingredients'], 0, 4000); }
    if (!empty($s['has_nutrition']) && $cur['unit'] !== 'each') {
        foreach (NUTRIENTS as $n) {
            if ($cur[$n] === null && $s['nutrition'][$n] !== null) { $set[] = "$n = ?"; $vals[] = $s['nutrition'][$n]; }
        }
    }
    q('UPDATE products SET ' . implode(', ', $set) . ' WHERE id = ?', [...$vals, $id]);
}

/** Read a nutrition label / ingredient list photo with Claude. Off unless anthropic_key is set in config.php. */
function read_label(string $b64, string $mime): array
{
    $key = (string)config('anthropic_key', '');
    if ($key === '' || !function_exists('curl_init')) {
        fail('Label reading is switched off. Type the numbers from the photo instead.');
    }
    $prompt = <<<TXT
    This photo shows a packaged food label from South Africa: a nutrition information table and/or an ingredients list.
    Reply with only a JSON object, no other text:
    {"column": "100g" | "100ml" | "serving" | null, "energy_kj": number|null, "protein_g": number|null, "carbs_g": number|null, "sugar_g": number|null, "fat_g": number|null, "satfat_g": number|null, "fibre_g": number|null, "sodium_mg": number|null, "ingredients": string|null}
    Rules: use the per 100 g (or per 100 ml) column, never per serving; set "column" to the column you used.
    Carbs means total (glycaemic) carbohydrate; sugar is "of which total sugar". If only kcal is given, energy_kj = kcal * 4.184.
    If salt is given instead of sodium, sodium_mg = salt in g * 400. Sodium in g -> multiply by 1000 for mg.
    ingredients: the ingredient list text exactly as printed, or null if not in the photo. Use null for anything you cannot read clearly. Never guess.
    TXT;
    $ch = curl_init((string)config('anthropic_url', 'https://api.anthropic.com/v1/messages'));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 45,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER => ['content-type: application/json', 'x-api-key: ' . $key, 'anthropic-version: 2023-06-01'],
        CURLOPT_POSTFIELDS => json_encode([
            'model' => (string)config('label_model', 'claude-haiku-5-5'),
            'max_tokens' => 1500,
            'messages' => [['role' => 'user', 'content' => [
                ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $mime, 'data' => $b64]],
                ['type' => 'text', 'text' => $prompt],
            ]]],
        ]),
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $resp = is_string($body) ? json_decode($body, true) : null;
    if ($code !== 200 || !is_array($resp)) {
        fail('Could not read the label (' . ($resp['error']['message'] ?? "HTTP $code") . ')', 502);
    }
    $text = '';
    foreach ((array)($resp['content'] ?? []) as $c) {
        if (($c['type'] ?? '') === 'text') { $text .= $c['text']; }
    }
    if (!preg_match('/\{.*\}/s', $text, $m) || !is_array($j = json_decode($m[0], true))) {
        fail('Could not read the label. Try a sharper, straight-on photo.', 502);
    }
    $limits = ['energy_kj' => 4000, 'protein_g' => 100, 'carbs_g' => 100, 'sugar_g' => 100, 'fat_g' => 100, 'satfat_g' => 100, 'fibre_g' => 100, 'sodium_mg' => 40000];
    $n = [];
    foreach ($limits as $k => $max) {
        $v = $j[$k] ?? null;
        $n[$k] = is_numeric($v) && $v >= 0 && $v <= $max ? round((float)$v, 2) : null;
    }
    $col = in_array($j['column'] ?? null, ['100g', '100ml', 'serving'], true) ? $j['column'] : null;
    $ing = is_string($j['ingredients'] ?? null) ? mb_substr(trim($j['ingredients']), 0, 4000) : null;
    return ['nutrition' => $n, 'column' => $col, 'ingredients' => $ing ?: null, 'additives' => additives_in($ing)];
}

function off_lookup(string $barcode): ?array
{
    if (!function_exists('curl_init')) {
        return null;
    }
    $fields = 'product_name,brands,quantity,product_quantity,product_quantity_unit,nutriments,nutriscore_grade,nova_group,additives_tags,ingredients_text_en,ingredients_text';
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

/* ----- giving back to Open Food Facts ----- */

/** Set up once a global app account is in config (off_user / off_password); otherwise sharing stays off. */
function off_ready(): bool
{
    return function_exists('curl_init') && (string)config('off_user', '') !== '' && (string)config('off_password', '') !== '';
}

/** A real retail barcode (not a shop's own weighed-item code starting with 2). */
function shareable_barcode(?string $b): bool
{
    return $b !== null && preg_match('/^(\d{8}|\d{12,14})$/', $b) === 1 && $b[0] !== '2' && !str_starts_with($b, '02');
}

function off_http(string $path, ?array $post = null): array
{
    $base = rtrim((string)config('off_base', 'https://world.openfoodfacts.org'), '/');
    $ch = curl_init($base . $path);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_USERAGENT => 'KitchenBudget/1.0 (' . (string)config('off_contact', 'kitchen budget app') . ')',
    ];
    if ((string)config('off_basic_auth', '') !== '') {
        $opts[CURLOPT_USERPWD] = (string)config('off_basic_auth');   // the staging server wants off:off
    }
    if ($post !== null) {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = $post;   // an array: sent as multipart, so photos can ride along
    }
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        throw new RuntimeException('Open Food Facts unreachable: ' . $err);
    }
    return [$code, (string)$body];
}

/** Numbers a real label could have; anything else isn't sent. */
function off_plausible(array $p): bool
{
    $limits = ['energy_kj' => 3800, 'protein_g' => 100, 'carbs_g' => 100, 'sugar_g' => 100, 'fat_g' => 100, 'satfat_g' => 100, 'fibre_g' => 100, 'sodium_mg' => 40000];
    foreach ($limits as $k => $max) {
        if ($p[$k] !== null && ((float)$p[$k] < 0 || (float)$p[$k] > $max)) {
            return false;
        }
    }
    if ($p['sugar_g'] !== null && $p['carbs_g'] !== null && (float)$p['sugar_g'] > (float)$p['carbs_g'] + 0.5) {
        return false;
    }
    if ($p['satfat_g'] !== null && $p['fat_g'] !== null && (float)$p['satfat_g'] > (float)$p['fat_g'] + 0.5) {
        return false;
    }
    return (float)($p['protein_g'] ?? 0) + (float)($p['carbs_g'] ?? 0) + (float)($p['fat_g'] ?? 0) <= 105;
}

/**
 * Add what Open Food Facts is missing about one product: only empty fields are filled, nothing of theirs is overwritten.
 * Returns 'sent', 'exists' (they already had everything) or 'skipped' (nothing worth sending).
 */
function off_contribute(int $productId, ?int $userId): string
{
    $p = q('SELECT * FROM products WHERE id = ?', [$productId])->fetch();
    if (!$p || !shareable_barcode($p['barcode']) || mb_strlen(trim((string)$p['name'])) < 3) {
        return 'skipped';
    }
    [$code, $body] = off_http('/api/v2/product/' . $p['barcode'] . '.json?fields=product_name,brands,quantity,nutriments,ingredients_text,ingredients_text_en,image_front_url,image_nutrition_url,image_ingredients_url');
    $d = json_decode($body, true);
    if (!is_array($d) || ($code !== 200 && $code !== 404)) {
        throw new RuntimeException("Open Food Facts lookup failed ($code)");
    }
    $have = (int)($d['status'] ?? 0) === 1 ? (array)($d['product'] ?? []) : [];
    $empty = fn($k) => trim((string)($have[$k] ?? '')) === '';
    $auth = [
        'code' => $p['barcode'],
        'user_id' => (string)config('off_user'),
        'password' => (string)config('off_password'),
        'app_name' => 'KitchenBudget',
        'app_version' => '1',
        // a salted id per person, so Open Food Facts can block one bad contributor without blocking the app; no name or email is sent
        'app_uuid' => substr(hash_hmac('sha256', 'off:' . (int)$userId, (string)config('off_password')), 0, 32),
        'comment' => 'Added with the Kitchen Budget app (South Africa)',
    ];
    $f = [];
    if ($empty('product_name')) {
        $f['product_name_en'] = trim((string)$p['name']);
    }
    if ($empty('brands') && trim((string)$p['brand']) !== '') {
        $f['add_brands'] = trim((string)$p['brand']);
    }
    if ($empty('quantity') && $p['unit'] !== 'each' && (float)$p['pack_size'] > 0) {
        $f['quantity'] = rtrim(rtrim(number_format((float)$p['pack_size'], 3, '.', ''), '0'), '.') . ' ' . $p['unit'];
    }
    if ($empty('ingredients_text') && $empty('ingredients_text_en') && trim((string)$p['ingredients']) !== '') {
        $f['ingredients_text_en'] = trim((string)$p['ingredients']);
    }
    $n = (array)($have['nutriments'] ?? []);
    $theirs = isset($n['energy_100g']) || isset($n['energy-kj_100g']) || isset($n['proteins_100g']);
    $ours = $p['energy_kj'] !== null || $p['protein_g'] !== null;
    if (!$theirs && $ours && $p['unit'] !== 'each' && off_plausible($p)) {
        $f['nutrition_data_per'] = '100g';
        $map = ['energy_kj' => ['energy-kj', 'kJ'], 'protein_g' => ['proteins', 'g'], 'carbs_g' => ['carbohydrates', 'g'], 'sugar_g' => ['sugars', 'g'],
                'fat_g' => ['fat', 'g'], 'satfat_g' => ['saturated-fat', 'g'], 'fibre_g' => ['fiber', 'g'], 'sodium_mg' => ['sodium', 'mg']];
        foreach ($map as $col => [$name, $unit]) {
            if ($p[$col] !== null) {
                $f["nutriment_$name"] = (string)(float)$p[$col];
                $f["nutriment_{$name}_unit"] = $unit;
            }
        }
    }
    // label photos they don't have yet (CC BY-SA once uploaded)
    $slots = ['front' => ['front_en', 'image_front_url'], 'label' => ['nutrition_en', 'image_nutrition_url'], 'ingredients' => ['ingredients_en', 'image_ingredients_url']];
    $photos = [];
    foreach (q('SELECT kind, mime, data FROM product_photos WHERE product_id = ?', [$productId])->fetchAll() as $ph) {
        [$field, $theirUrl] = $slots[$ph['kind']] ?? [null, null];
        if ($field && $empty($theirUrl)) {
            $photos[$field] = $ph;
        }
    }
    if (!$f && !$photos) {
        return $have ? 'exists' : 'skipped';
    }
    if ($f || !$have) {
        $f['add_countries'] = 'South Africa';
        [$c, $b] = off_http('/cgi/product_jqm2.pl', $auth + $f + ['lc' => 'en', 'cc' => 'za']);
        $r = json_decode($b, true);
        if ($c !== 200 || (int)($r['status'] ?? 0) !== 1) {
            throw new RuntimeException('Open Food Facts said: ' . mb_substr((string)($r['status_verbose'] ?? "HTTP $c"), 0, 150));
        }
    }
    foreach ($photos as $field => $ph) {
        $tmp = tempnam(sys_get_temp_dir(), 'off');
        file_put_contents($tmp, base64_decode($ph['data']));
        try {
            [$c, $b] = off_http('/cgi/product_image_upload.pl', $auth + ['imagefield' => $field, "imgupload_$field" => new CURLFile($tmp, $ph['mime'], 'label.jpg')]);
        } finally {
            @unlink($tmp);
        }
        $r = json_decode($b, true);
        if ($c !== 200 || (($r['status'] ?? '') !== 'status ok' && empty($r['image']))) {
            throw new RuntimeException('Photo upload failed: ' . mb_substr((string)($r['error'] ?? $r['status'] ?? "HTTP $c"), 0, 150));
        }
    }
    return 'sent';
}

/** Queue a product for sharing, if the person said yes and it has a real barcode. */
function off_queue(int $productId, int $userId): bool
{
    $bc = q('SELECT barcode FROM products WHERE id = ?', [$productId])->fetchColumn();
    if (!off_ready() || !shareable_barcode($bc ?: null)) {
        return false;
    }
    q("INSERT INTO off_contributions (product_id, user_id, status, attempts) VALUES (?, ?, 'pending', 0)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), status = 'pending', attempts = 0, last_error = NULL", [$productId, $userId]);
    return true;
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
    $grade = strtolower((string)($p['nutriscore_grade'] ?? ''));
    $nova = (int)($p['nova_group'] ?? 0);
    $health = [
        'nutriscore' => in_array($grade, ['a', 'b', 'c', 'd', 'e'], true) ? $grade : null,
        'nova' => $nova >= 1 && $nova <= 4 ? $nova : null,
        'additives' => clean_additives(array_map(fn($t) => preg_replace('/^[a-z]{2}:/', '', (string)$t), (array)($p['additives_tags'] ?? []))),
        'ingredients' => trim((string)($p['ingredients_text_en'] ?? '')) ?: (trim((string)($p['ingredients_text'] ?? '')) ?: null),
    ];
    return $health + [
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
$kid = kitchen_of($uid);

// an offline change carries an op_id; if we've already applied it, answer the same way again
if (isset($in['op_id']) && preg_match('/^[0-9a-f-]{36}$/', (string)$in['op_id'])) {
    $done = q('SELECT response FROM op_log WHERE op_id = ?', [$in['op_id']])->fetchColumn();
    if ($done !== false) {
        header('Content-Type: application/json; charset=utf-8');
        echo $done;
        exit;
    }
    $OP_ID = $in['op_id'];
    if (random_int(1, 50) === 1) {
        q('DELETE FROM op_log WHERE created_at < NOW() - INTERVAL 14 DAY');
    }
}

try {
    switch ($action) {

        case 'bootstrap':
            $month = date('Y-m');
            q('UPDATE users SET last_seen = NOW() WHERE id = ?', [$uid]);
            if (!q('SELECT 1 FROM stores WHERE user_id = ? LIMIT 1', [$kid])->fetchColumn()) {
                // a fresh account starts with the usual shops (no prices yet)
                foreach (DEFAULT_STORES as $n) {
                    q('INSERT IGNORE INTO stores (user_id, name) VALUES (?, ?)', [$kid, $n]);
                }
            }
            out([
                'user' => $user,
                'users' => array_map(fn($u) => [
                    'id' => (int)$u['id'],
                    'display_name' => $u['display_name'],
                    'protein_target_g' => $u['protein_target_g'] === null ? null : (int)$u['protein_target_g'],
                    'kj_target' => $u['kj_target'] === null ? null : (int)$u['kj_target'],
                ], q('SELECT id, display_name, protein_target_g, kj_target FROM users WHERE id = ?', [$uid])->fetchAll()),
                'stores' => q('SELECT id, name FROM stores WHERE user_id = ? ORDER BY name', [$kid])->fetchAll(),
                'budget' => (float)user_setting('monthly_budget', '0'),
                'spent' => period_spent(pay_period()),
                'period' => pay_period(),
                'payday' => (int)user_setting('payday', '1'),
                'alerts' => alert_prefs(),
                'takeaway_weekly' => (float)user_setting('takeaway_weekly', '100'),
                'label_reader' => (string)config('anthropic_key', '') !== '',
                'is_admin' => !empty($user['is_admin']),
                'signups_open' => setting('signups_open', '1') === '1',
                'household' => household_view($uid),
                'off_ready' => off_ready(),
                'off_share' => user_setting('off_share', ''),
                'month' => $month,
                'currency' => config('currency', 'R'),
            ]);

        case 'logout':
            log_out();
            out(['ok' => true]);

        // ----- stores -----
        case 'stores.add':
            if (q('SELECT 1 FROM stores WHERE user_id = ? AND name = ?', [$kid, str_in($in, 'name', 60, true)])->fetchColumn()) {
                fail('You already have that shop');
            }
            q('INSERT INTO stores (user_id, name) VALUES (?, ?)', [$kid, str_in($in, 'name', 60, true)]);
            out(['id' => (int)db()->lastInsertId()]);

        case 'stores.rename':
            q('UPDATE stores SET name = ? WHERE id = ? AND user_id = ?', [str_in($in, 'name', 60, true), int_in($in, 'id'), $kid]);
            out(['ok' => true]);

        case 'stores.delete':
            q('DELETE FROM stores WHERE id = ? AND user_id = ?', [int_in($in, 'id'), $kid]);
            out(['ok' => true]);

        // ----- products -----
        case 'products.list':
            $prices = latest_prices();
            $rows = array_map(fn($r) => product_row($r, $prices), q('SELECT p.*, pa.amount pantry, pa.bought_count, pa.last_bought FROM products p LEFT JOIN pantry pa ON pa.product_id = p.id AND pa.user_id = ? ORDER BY p.name', [$kid])->fetchAll());
            $photos = [];
            foreach (q('SELECT id, product_id, kind FROM product_photos ORDER BY id DESC') as $ph) {
                $photos[(int)$ph['product_id']][] = ['id' => (int)$ph['id'], 'kind' => $ph['kind']];
            }
            foreach ($rows as &$r) {
                $r['photos'] = $photos[$r['id']] ?? [];
            }
            unset($r);
            $offPending = (int)q("SELECT COUNT(*) FROM products WHERE barcode IS NOT NULL AND barcode NOT LIKE '2%' AND off_checked_at IS NULL")->fetchColumn();
            out(['off_pending' => $offPending, 'products' => $rows, 'aisle_order' => json_decode(user_setting('aisle_order', DEFAULT_AISLES), true) ?: []]);

        case 'pantry.set':
            $pid = int_in($in, 'product_id');
            $amount = num_in($in, 'amount', 0, 0, 1e7);
            q('INSERT INTO pantry (user_id, product_id, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)', [$kid, $pid, $amount]);
            out(['ok' => true]);

        case 'aisles.set':
            $order = array_values(array_unique(array_filter(array_map(fn($x) => mb_substr(trim((string)$x), 0, 40), (array)($in['order'] ?? [])))));
            set_user_setting('aisle_order', json_encode($order, JSON_UNESCAPED_UNICODE));
            out(['aisle_order' => $order]);

        case 'products.lookup':
            $code = preg_replace('/\D/', '', (string)($in['barcode'] ?? ''));
            if ($code === '' || strlen($code) > 32) {
                fail('Invalid barcode');
            }
            if (strlen($code) === 13 && $code[0] === '2') {
                // a shop's own label for weighed items (meat, deli): it encodes a price or weight, not a product
                out(['product' => null, 'suggestion' => null, 'barcode' => $code, 'instore' => true]);
            }
            $row = q('SELECT p.*, pa.amount pantry, pa.bought_count, pa.last_bought FROM products p LEFT JOIN pantry pa ON pa.product_id = p.id AND pa.user_id = ? WHERE p.barcode = ?', [$kid, $code])->fetch();
            if ($row) {
                out(['product' => product_row($row, latest_prices([(int)$row['id']])), 'suggestion' => null]);
            }
            out(['product' => null, 'suggestion' => off_lookup($code), 'barcode' => $code]);

        case 'products.off':
            // fetch Open Food Facts data for an existing product's barcode (e.g. to fill in nutrition later)
            $code = preg_replace('/\D/', '', (string)($in['barcode'] ?? ''));
            out(['suggestion' => $code === '' ? null : off_lookup($code)]);

        case 'products.refresh_off':
            // fetch Nutri-Score / NOVA / additives for scanned products that haven't been checked; a few per call
            $todo = q("SELECT id, barcode FROM products WHERE barcode IS NOT NULL AND barcode NOT LIKE '2%' AND (off_checked_at IS NULL OR ?) ORDER BY id LIMIT 6", [!empty($in['all']) ? 1 : 0])->fetchAll();
            if (!empty($in['all'])) {
                q('UPDATE products SET off_checked_at = NULL WHERE barcode IS NOT NULL');   // start a full pass
                $in['all'] = false;
            }
            foreach ($todo as $t) {
                apply_off((int)$t['id'], off_lookup($t['barcode']));
            }
            $left = (int)q("SELECT COUNT(*) FROM products WHERE barcode IS NOT NULL AND barcode NOT LIKE '2%' AND off_checked_at IS NULL")->fetchColumn();
            out(['checked' => count($todo), 'left' => $left]);

        case 'products.photo':
            // save a label photo (JPEG/PNG as base64, already shrunk on the phone)
            $pid = int_in($in, 'product_id');
            $mime = in_array($in['mime'] ?? '', ['image/jpeg', 'image/png', 'image/webp'], true) ? $in['mime'] : fail('Unsupported image');
            $data = (string)($in['data'] ?? '');
            if ($data === '' || strlen($data) > 1400000 || base64_decode($data, true) === false) {
                fail('Photo too large or unreadable');
            }
            $kind = in_array($in['kind'] ?? '', ['label', 'ingredients', 'front'], true) ? $in['kind'] : 'label';
            q('DELETE FROM product_photos WHERE product_id = ? AND kind = ?', [$pid, $kind]);
            q('INSERT INTO product_photos (product_id, kind, mime, data, user_id) VALUES (?, ?, ?, ?, ?)', [$pid, $kind, $mime, $data, $uid]);
            out(['id' => (int)db()->lastInsertId()]);

        case 'products.photo_delete':
            q('DELETE FROM product_photos WHERE id = ?', [int_in($in, 'id')]);
            out(['ok' => true]);

        case 'label.read':
            $mime = in_array($in['mime'] ?? '', ['image/jpeg', 'image/png', 'image/webp'], true) ? $in['mime'] : 'image/jpeg';
            $data = (string)($in['data'] ?? '');
            if ($data === '' && ($photoId = int_in($in, 'photo_id', false))) {
                $ph = q('SELECT mime, data FROM product_photos WHERE id = ?', [$photoId])->fetch() ?: fail('Photo not found', 404);
                [$mime, $data] = [$ph['mime'], $ph['data']];
            }
            if ($data === '' || strlen($data) > 1400000) {
                fail('Photo too large or missing');
            }
            out(read_label($data, $mime));

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
            if (array_key_exists('ingredients', $in)) {
                $fields['ingredients'] = str_in($in, 'ingredients', 4000);
            }
            // health info from Open Food Facts travels with the form; additives also come from the typed ingredient list
            $grade = strtolower((string)($in['nutriscore'] ?? ''));
            if (in_array($grade, ['a', 'b', 'c', 'd', 'e'], true)) {
                $fields['nutriscore'] = $grade;
            }
            $nova = (int)($in['nova'] ?? 0);
            if ($nova >= 1 && $nova <= 4) {
                $fields['nova'] = $nova;
            }
            $adds = clean_additives(array_merge((array)($in['additives'] ?? []), additives_in($fields['ingredients'] ?? null)));
            if ($adds || array_key_exists('ingredients', $in)) {
                $fields['additives'] = $adds ? implode(',', $adds) : null;
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
                $fields['created_by'] = $uid;
                $cols = array_keys($fields);
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
            $row = q('SELECT p.*, pa.amount pantry, pa.bought_count, pa.last_bought FROM products p LEFT JOIN pantry pa ON pa.product_id = p.id AND pa.user_id = ? WHERE p.id = ?', [$kid, $id])->fetch();
            out(['product' => product_row($row, latest_prices([$id]))]);

        case 'products.price':
            record_price(int_in($in, 'product_id'), int_in($in, 'store_id'), num_in($in, 'price', null, 0, 1e6) ?? fail('Missing price'), $uid);
            out(['ok' => true]);

        case 'products.history':
            out(['history' => q('SELECT pr.price, pr.recorded_at, s.name store, u.display_name who
                                  FROM prices pr JOIN stores s ON s.id = pr.store_id AND s.user_id = ? LEFT JOIN users u ON u.id = pr.user_id
                                  WHERE pr.product_id = ? ORDER BY pr.id DESC LIMIT 50', [$kid, int_in($in, 'id')])->fetchAll()]);

        case 'products.delete':
            // products are shared by everyone: only the person who added it (or an admin) can delete it
            $pid = int_in($in, 'id');
            $by = q('SELECT created_by FROM products WHERE id = ?', [$pid])->fetchColumn();
            if ($by === false) {
                fail('Not found', 404);
            }
            if ((int)$by !== $uid && empty($user['is_admin'])) {
                fail('Other people use this product. Only the person who added it can delete it.', 403);
            }
            q('DELETE FROM products WHERE id = ?', [$pid]);
            out(['ok' => true]);

        // ----- shopping list -----
        case 'list.get':
            $items = q('SELECT li.*, u.display_name added_by_name, p.pack_size, p.unit, p.brand, p.category
                        FROM list_items li LEFT JOIN products p ON p.id = li.product_id LEFT JOIN users u ON u.id = li.added_by
                        WHERE li.user_id = ? ORDER BY li.checked, li.created_at, li.id', [$kid])->fetchAll();
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
            $lastShop = q("SELECT MAX(trip_date) FROM trips WHERE user_id = ? AND kind = 'groceries'", [$kid])->fetchColumn();
            out([
                'items' => $items,
                'spent' => period_spent(pay_period()),
                'period' => pay_period(),
                'budget' => (float)user_setting('monthly_budget', '0'),
                'takeaway' => takeaway_week(),
                'fridge' => fridge_list(),
                'today' => plan_entries(date('Y-m-d'), date('Y-m-d')),
                'last_shop' => $lastShop ?: null,
            ]);

        case 'list.add':
            $pid = int_in($in, 'product_id', false);
            $qty = num_in($in, 'qty', 1, 0.01, 1000);
            $checked = !empty($in['checked']) ? 1 : 0;   // scanned in the shop: straight into the trolley
            if ($pid) {
                $name = q('SELECT name FROM products WHERE id = ?', [$pid])->fetchColumn();
                if ($name === false) {
                    fail('Unknown product');
                }
                $existing = $checked
                    ? q('SELECT id FROM list_items WHERE user_id = ? AND product_id = ? AND checked = 1 LIMIT 1', [$kid, $pid])->fetchColumn()
                    : q('SELECT id FROM list_items WHERE user_id = ? AND product_id = ? AND checked = 0 AND from_plan = 0 LIMIT 1', [$kid, $pid])->fetchColumn();
                if ($existing) {
                    q('UPDATE list_items SET qty = qty + ? WHERE id = ?', [$qty, $existing]);
                    out(['id' => (int)$existing]);
                }
            } else {
                $name = str_in($in, 'name', 120, true);
            }
            q('INSERT INTO list_items (user_id, product_id, name, qty, unit_price, added_by, checked) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$kid, $pid, $name, $qty, $pid ? null : num_in($in, 'unit_price', null, 0, 1e6), $uid, $checked]);
            out(['id' => (int)db()->lastInsertId()]);

        case 'list.update':
            $id = int_in($in, 'id');
            $item = q('SELECT * FROM list_items WHERE id = ? AND user_id = ?', [$id, $kid])->fetch() ?: fail('Item not found', 404);
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
            q('DELETE FROM list_items WHERE id = ? AND user_id = ?', [int_in($in, 'id'), $kid]);
            out(['ok' => true]);

        case 'list.clear':
            q(!empty($in['all']) ? 'DELETE FROM list_items WHERE user_id = ?' : 'DELETE FROM list_items WHERE user_id = ? AND checked = 1', [$kid]);
            out(['ok' => true]);

        case 'list.checkout':
            $storeId = own_store(int_in($in, 'store_id', false));
            $date = date_in($in, 'date', date('Y-m-d'));
            $items = q('SELECT * FROM list_items WHERE user_id = ? AND checked = 1', [$kid])->fetchAll();
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
            q('INSERT INTO trips (trip_date, store_id, total, note, user_id, estimate, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$date, $storeId, $total, str_in($in, 'note', 200), $kid, round($estimate, 2), $uid]);
            foreach ($items as $i) {
                if ($i['product_id'] !== null) {
                    $pack = q('SELECT pack_size FROM products WHERE id = ?', [$i['product_id']])->fetchColumn();
                    if ($pack !== false) {
                        pantry_add((int)$i['product_id'], (float)$i['qty'] * (float)$pack);
                        q('UPDATE pantry SET bought_count = bought_count + 1, last_bought = ? WHERE user_id = ? AND product_id = ?', [$date, $kid, $i['product_id']]);
                    }
                }
            }
            q('DELETE FROM list_items WHERE user_id = ? AND checked = 1', [$kid]);
            db()->commit();
            out(['total' => $total, 'estimate' => round($estimate, 2), 'spent' => period_spent(pay_period())]);

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
                own_recipe($id);
                q('UPDATE recipes SET name = ?, servings = ?, instructions = ?, prep_minutes = ?, cook_minutes = ? WHERE id = ?', [...$vals, $id]);
                q('DELETE FROM recipe_items WHERE recipe_id = ?', [$id]);
                q('DELETE FROM recipe_steps WHERE recipe_id = ?', [$id]);
            } else {
                q('INSERT INTO recipes (name, servings, instructions, prep_minutes, cook_minutes, user_id) VALUES (?, ?, ?, ?, ?, ?)', [...$vals, $uid]);
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

        case 'recipes.servings':
            // how many portions the recipe's batch makes; the ingredients stay the same
            own_recipe(int_in($in, 'id'));
            q('UPDATE recipes SET servings = ? WHERE id = ?', [(int)(num_in($in, 'servings', null, 1, 100) ?? fail('How many portions?')), int_in($in, 'id')]);
            out(['ok' => true]);

        case 'recipes.delete':
            $rid = int_in($in, 'id');
            own_recipe($rid);
            $others = (int)q('SELECT COUNT(DISTINCT user_id) FROM plan WHERE recipe_id = ? AND user_id NOT IN (?, ?)', [$rid, $uid, $kid])->fetchColumn();   // other kitchens
            if ($others) {
                fail($others === 1 ? 'Someone else has this recipe in their meal plan. Unshare it instead, so nobody new can add it.' : "$others people have this recipe in their meal plan. Unshare it instead, so nobody new can add it.");
            }
            q('DELETE FROM recipes WHERE id = ?', [$rid]);
            out(['ok' => true]);

        case 'recipes.share':
            $rid = int_in($in, 'id');
            own_recipe($rid);
            q('UPDATE recipes SET is_public = ? WHERE id = ?', [!empty($in['public']) ? 1 : 0, $rid]);
            out(['recipe' => recipes_with_costs($rid)[0]]);

        case 'recipes.copy':
            // your own private copy of a recipe you can see, to change as you like
            $rid = int_in($in, 'id');
            can_see_recipe($rid) || fail('Recipe not found', 404);
            $r = q('SELECT * FROM recipes WHERE id = ?', [$rid])->fetch();
            db()->beginTransaction();
            q('INSERT INTO recipes (name, servings, instructions, prep_minutes, cook_minutes, user_id, is_public) VALUES (?, ?, ?, ?, ?, ?, 0)',
                [mb_substr($r['name'], 0, 120), $r['servings'], $r['instructions'], $r['prep_minutes'], $r['cook_minutes'], $uid]);
            $new = (int)db()->lastInsertId();
            q('INSERT INTO recipe_items (recipe_id, product_id, amount, note, sort) SELECT ?, product_id, amount, note, sort FROM recipe_items WHERE recipe_id = ?', [$new, $rid]);
            q('INSERT INTO recipe_steps (recipe_id, sort, body, timer_minutes) SELECT ?, sort, body, timer_minutes FROM recipe_steps WHERE recipe_id = ?', [$new, $rid]);
            db()->commit();
            out(['recipe' => recipes_with_costs($new)[0]]);

        case 'recipes.to_list':
            // add the packs needed for one batch of a recipe at a chosen number of portions
            $rid = int_in($in, 'id');
            can_see_recipe($rid) || fail('Recipe not found', 404);
            $portions = num_in($in, 'portions', null, 0.25, 500) ?? fail('Missing portions');
            $need = q('SELECT ri.product_id, p.name, p.pack_size, ri.amount * ? / r.servings amount
                       FROM recipe_items ri JOIN recipes r ON r.id = ri.recipe_id JOIN products p ON p.id = ri.product_id
                       WHERE r.id = ?', [$portions, $rid])->fetchAll();
            $byProduct = [];
            foreach ($need as $n) {
                $byProduct[(int)$n['product_id']] = ($byProduct[(int)$n['product_id']] ?? 0) + (float)$n['amount'];
            }
            out(['added' => need_to_list($byProduct, $uid, false)]);

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
            $cookPortions = num_in($in, 'portions', null, 0.25, 500) ?? fail('How many portions?');
            db()->beginTransaction();
            q('INSERT INTO fridge (recipe_id, name, portions, grams_per_portion, cost_per_portion, cooked_on, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [
                $rid, $name, $cookPortions,
                $grams === null ? null : (int)round($grams), $cpp, date_in($in, 'date', date('Y-m-d')), $kid,
            ]);
            if ($rid) {
                // cooking uses up what was at home
                foreach ($rec['items'] as $it) {
                    pantry_add($it['product_id'], -$it['amount'] * $cookPortions / $rec['servings']);
                }
            }
            db()->commit();
            out(['fridge' => fridge_list()]);

        case 'fridge.eat':
            q('UPDATE fridge SET portions = GREATEST(0, portions - ?) WHERE id = ? AND user_id = ?', [num_in($in, 'n', 1, 0.25, 500), int_in($in, 'id'), $kid]);
            q('DELETE FROM fridge WHERE user_id = ? AND portions <= 0', [$kid]);
            out(['fridge' => fridge_list()]);

        case 'fridge.set':
            q('UPDATE fridge SET portions = ? WHERE id = ? AND user_id = ?', [num_in($in, 'portions', null, 0, 500) ?? fail('Missing portions'), int_in($in, 'id'), $kid]);
            q('DELETE FROM fridge WHERE user_id = ? AND portions <= 0', [$kid]);
            out(['fridge' => fridge_list()]);

        case 'fridge.move':
            // freeze or thaw a batch; n portions splits them off into their own batch
            $id = int_in($in, 'id');
            $to = ($in['to'] ?? '') === 'freezer' ? 'freezer' : 'fridge';
            $b = q('SELECT * FROM fridge WHERE id = ? AND user_id = ?', [$id, $kid])->fetch() ?: fail('Not found', 404);
            $n = num_in($in, 'n', (float)$b['portions'], 0.25, 500);
            db()->beginTransaction();
            if ($n < (float)$b['portions'] - 1e-6) {
                q('UPDATE fridge SET portions = portions - ? WHERE id = ?', [$n, $id]);
                q('INSERT INTO fridge (recipe_id, name, portions, grams_per_portion, cost_per_portion, cooked_on, user_id, location, moved_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())',
                    [$b['recipe_id'], $b['name'], $n, $b['grams_per_portion'], $b['cost_per_portion'], $b['cooked_on'], $kid, $to]);
            } else {
                q('UPDATE fridge SET location = ?, moved_on = CURDATE() WHERE id = ?', [$to, $id]);
            }
            db()->commit();
            out(['fridge' => fridge_list()]);

        case 'fridge.delete':
            q('DELETE FROM fridge WHERE id = ? AND user_id = ?', [int_in($in, 'id'), $kid]);
            out(['fridge' => fridge_list()]);

        // ----- takeaways -----
        case 'takeaway.get':
            out(['takeaway' => takeaway_week()]);

        case 'takeaway.add':
            q("INSERT INTO trips (trip_date, store_id, total, note, user_id, kind, added_by) VALUES (?, NULL, ?, ?, ?, 'eating_out', ?)", [
                date_in($in, 'date', date('Y-m-d')),
                num_in($in, 'total', null, 0, 1e5) ?? fail('How much was it?'),
                str_in($in, 'note', 200), $uid, $uid,
            ]);
            out(['takeaway' => takeaway_week()]);

        case 'takeaway.set':
            set_user_setting('takeaway_weekly', number_format(num_in($in, 'weekly', 0, 0, 1e6), 2, '.', ''));
            out(['takeaway' => takeaway_week()]);

        // ----- meal plan -----
        case 'plan.get':
            out(['entries' => plan_entries(date_in($in, 'from'), date_in($in, 'to'))]);

        case 'plan.eat':
            // mark a planned meal eaten (or undo); takes its servings from the oldest fridge batches of that recipe
            $id = int_in($in, 'id');
            $p = q('SELECT * FROM plan WHERE id = ? AND user_id = ?', [$id, $kid])->fetch() ?: fail('Meal not found', 404);
            db()->beginTransaction();
            if (empty($in['undo'])) {
                if ($p['eaten_at'] !== null) {
                    db()->commit();
                    out(['taken' => 0.0]);
                }
                $want = (float)$p['servings'];
                $taken = 0.0;
                foreach (q("SELECT id, portions FROM fridge WHERE user_id = ? AND recipe_id = ? AND portions > 0 ORDER BY location = 'freezer', cooked_on, id FOR UPDATE", [$kid, $p['recipe_id']])->fetchAll() as $b) {
                    if ($taken >= $want) {
                        break;
                    }
                    $take = min((float)$b['portions'], $want - $taken);
                    q('UPDATE fridge SET portions = portions - ? WHERE id = ?', [$take, $b['id']]);
                    $taken += $take;
                }
                q('DELETE FROM fridge WHERE user_id = ? AND portions <= 0', [$kid]);
                q('UPDATE plan SET eaten_at = NOW(), fridge_taken = ? WHERE id = ?', [$taken, $id]);
                db()->commit();
                out(['taken' => $taken]);
            }
            $back = (float)$p['fridge_taken'];
            if ($back > 0) {
                $latest = q('SELECT id FROM fridge WHERE user_id = ? AND recipe_id = ? ORDER BY cooked_on DESC, id DESC LIMIT 1', [$kid, $p['recipe_id']])->fetchColumn();
                if ($latest) {
                    q('UPDATE fridge SET portions = portions + ? WHERE id = ?', [$back, $latest]);
                } else {
                    $rec = recipes_with_costs((int)$p['recipe_id'])[0] ?? null;
                    q('INSERT INTO fridge (recipe_id, name, portions, cost_per_portion, cooked_on, user_id) VALUES (?, ?, ?, ?, CURDATE(), ?)',
                        [$p['recipe_id'], $rec['name'] ?? 'Meal', $back, $rec && !$rec['missing_prices'] ? $rec['cost_per_serving'] : null, $kid]);
                }
            }
            q('UPDATE plan SET eaten_at = NULL, fridge_taken = 0 WHERE id = ?', [$id]);
            db()->commit();
            out(['returned' => $back]);

        case 'plan.set':
            $slot = in_array($in['slot'] ?? '', SLOTS, true) ? $in['slot'] : fail('Bad slot');
            $id = int_in($in, 'id', false);
            $vals = [date_in($in, 'date'), $slot, int_in($in, 'recipe_id'), num_in($in, 'servings', 1, 0.25, 50)];
            can_see_recipe($vals[2]) || fail('Recipe not found', 404);
            if ($id) {
                q('UPDATE plan SET plan_date = ?, slot = ?, recipe_id = ?, servings = ? WHERE id = ? AND user_id = ?', [...$vals, $id, $kid]);
            } else {
                q('INSERT INTO plan (plan_date, slot, recipe_id, servings, user_id) VALUES (?, ?, ?, ?, ?)', [...$vals, $kid]);
            }
            out(['ok' => true]);

        case 'plan.delete':
            q('DELETE FROM plan WHERE id = ? AND user_id = ?', [int_in($in, 'id'), $kid]);
            out(['ok' => true]);

        case 'plan.bulk':
            // add many planned meals at once (the week planner). mode 'fill' skips slots that already have a meal;
            // 'replace' clears the uneaten meals in those slots first.
            $mode = ($in['mode'] ?? 'fill') === 'replace' ? 'replace' : 'fill';
            $entries = array_values((array)($in['entries'] ?? []));
            if (count($entries) > 200) {
                fail('Too many meals at once');
            }
            $clean = [];
            foreach ($entries as $e) {
                $e = (array)$e;
                $slot = in_array($e['slot'] ?? '', SLOTS, true) ? $e['slot'] : fail('Bad slot');
                $clean[] = [date_in($e, 'date'), $slot, int_in($e, 'recipe_id'), num_in($e, 'servings', 1, 0.25, 50)];
                $seenRecipes[$clean[count($clean) - 1][2]] = true;
            }
            foreach (array_keys($seenRecipes ?? []) as $rid) {
                can_see_recipe($rid) || fail('Recipe not found', 404);
            }
            db()->beginTransaction();
            $added = 0;
            $slotsDone = [];
            foreach ($clean as [$date, $slot, $rid, $servings]) {
                $key = "$date|$slot";
                if ($mode === 'replace' && !isset($slotsDone[$key])) {
                    q('DELETE FROM plan WHERE user_id = ? AND plan_date = ? AND slot = ? AND eaten_at IS NULL', [$kid, $date, $slot]);
                } elseif ($mode === 'fill' && !isset($slotsDone[$key])
                    && q('SELECT 1 FROM plan WHERE user_id = ? AND plan_date = ? AND slot = ? LIMIT 1', [$kid, $date, $slot])->fetchColumn()) {
                    $slotsDone[$key] = 'skip';
                }
                if (($slotsDone[$key] ?? null) === 'skip') {
                    continue;
                }
                $slotsDone[$key] = 'done';
                q('INSERT INTO plan (plan_date, slot, recipe_id, servings, user_id) VALUES (?, ?, ?, ?, ?)', [$date, $slot, $rid, $servings, $kid]);
                $added++;
            }
            db()->commit();
            out(['added' => $added]);

        case 'plan.copy_week':
            // copy one week's plan onto the following week
            $from = date_in($in, 'from');
            $rows = q('SELECT * FROM plan WHERE user_id = ? AND plan_date BETWEEN ? AND DATE_ADD(?, INTERVAL 6 DAY)', [$kid, $from, $from])->fetchAll();
            foreach ($rows as $r) {
                q('INSERT INTO plan (plan_date, slot, recipe_id, servings, user_id) VALUES (DATE_ADD(?, INTERVAL 7 DAY), ?, ?, ?, ?)',
                    [$r['plan_date'], $r['slot'], $r['recipe_id'], $r['servings'], $kid]);
            }
            out(['copied' => count($rows)]);

        case 'plan.to_list':
            $from = date_in($in, 'from');
            $to = date_in($in, 'to');
            // portions still to cook per recipe = uneaten planned servings - what's already cooked in the fridge
            $toCook = [];
            foreach (q('SELECT recipe_id, SUM(servings) s FROM plan WHERE user_id = ? AND plan_date BETWEEN ? AND ? AND eaten_at IS NULL GROUP BY recipe_id', [$kid, $from, $to]) as $r) {
                $toCook[(int)$r['recipe_id']] = (float)$r['s'];
            }
            foreach (q('SELECT recipe_id, SUM(portions) p FROM fridge WHERE user_id = ? AND recipe_id IS NOT NULL GROUP BY recipe_id', [$kid]) as $r) {
                if (isset($toCook[(int)$r['recipe_id']])) {
                    $toCook[(int)$r['recipe_id']] -= (float)$r['p'];
                }
            }
            $need = [];
            foreach ($toCook as $rid => $portions) {
                if ($portions <= 0) {
                    continue;
                }
                foreach (q('SELECT ri.product_id, ri.amount, r.servings FROM recipe_items ri JOIN recipes r ON r.id = ri.recipe_id WHERE r.id = ?', [$rid]) as $it) {
                    $need[(int)$it['product_id']] = ($need[(int)$it['product_id']] ?? 0) + (float)$it['amount'] * $portions / max(1, (int)$it['servings']);
                }
            }
            db()->beginTransaction();
            q('DELETE FROM list_items WHERE user_id = ? AND from_plan = 1 AND checked = 0', [$kid]);
            $added = need_to_list($need, $uid, true);
            db()->commit();
            out(['added' => $added]);

        // ----- budget / trips -----
        case 'budget.get':
            $period = pay_period(date_in($in, 'date', date('Y-m-d')));
            $month = substr($period['start'], 0, 7);
            $trips = q("SELECT t.id, t.trip_date, t.total, t.estimate, t.note, t.kind, s.name store, u.display_name who
                        FROM trips t LEFT JOIN stores s ON s.id = t.store_id LEFT JOIN users u ON u.id = COALESCE(t.added_by, t.user_id)
                        WHERE ((t.user_id = ? AND t.kind = 'groceries') OR (t.user_id = ? AND t.kind = 'eating_out'))
                          AND t.trip_date BETWEEN ? AND ? ORDER BY t.trip_date DESC, t.id DESC", [$kid, $uid, $period['start'], $period['end']])->fetchAll();
            foreach ($trips as &$t) {
                $t['total'] = (float)$t['total'];
                $t['estimate'] = $t['estimate'] === null ? null : (float)$t['estimate'];
            }
            unset($t);
            out([
                'month' => $month,
                'period' => $period,
                'payday' => (int)user_setting('payday', '1'),
                'pay_marks' => q('SELECT paid_on FROM pay_dates WHERE user_id = ? ORDER BY paid_on DESC LIMIT 6', [$kid])->fetchAll(PDO::FETCH_COLUMN),
                'budget' => (float)user_setting('monthly_budget', '0'),
                'spent' => period_spent($period),
                'eating_out' => period_spent($period, 'eating_out'),
                'takeaway_weekly' => (float)user_setting('takeaway_weekly', '100'),
                'aisle_order' => json_decode(user_setting('aisle_order', DEFAULT_AISLES), true) ?: [],
                'trips' => $trips,
            ]);

        case 'budget.set':
            if (array_key_exists('monthly_budget', $in)) {
                set_user_setting('monthly_budget', number_format(num_in($in, 'monthly_budget', 0, 0, 1e7), 2, '.', ''));
            }
            if (array_key_exists('payday', $in)) {
                set_user_setting('payday', (string)(int)(num_in($in, 'payday', 1, 1, 31)));
            }
            out(['ok' => true, 'period' => pay_period()]);

        case 'pay.mark':
            // "I got paid today" (or on a date): starts a new pay period, e.g. early December pay
            q('INSERT IGNORE INTO pay_dates (user_id, paid_on) VALUES (?, ?)', [$kid, date_in($in, 'date', date('Y-m-d'))]);
            out(['period' => pay_period()]);

        case 'pay.unmark':
            q('DELETE FROM pay_dates WHERE user_id = ? AND paid_on = ?', [$kid, date_in($in, 'date')]);
            out(['period' => pay_period()]);

        case 'alerts.set':
            // mode 'always' | 'never' | null (back to normal) for an E-number, a group or a word
            $code = mb_strtolower(trim((string)($in['code'] ?? '')));
            $code = preg_replace('/^e\s*-?\s*(\d)/u', 'e$1', $code);
            if ($code === '' || mb_strlen($code) > 40) {
                fail('What should the alert look for?');
            }
            $mode = $in['mode'] ?? null;
            if ($mode === null || $mode === '') {
                q('DELETE FROM ingredient_alerts WHERE user_id = ? AND code = ?', [$uid, $code]);
            } elseif (in_array($mode, ['always', 'never'], true)) {
                q('INSERT INTO ingredient_alerts (user_id, code, mode) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mode = VALUES(mode)', [$uid, $code, $mode]);
            } else {
                fail('Bad mode');
            }
            out(['alerts' => alert_prefs()]);

        case 'list.swap':
            // replace the open list lines for one product with another
            $from = int_in($in, 'from');
            $to = int_in($in, 'to');
            $name = q('SELECT name FROM products WHERE id = ?', [$to])->fetchColumn() ?: fail('Unknown product');
            $lines = q('SELECT id FROM list_items WHERE user_id = ? AND product_id = ? AND checked = 0', [$kid, $from])->fetchAll(PDO::FETCH_COLUMN);
            db()->beginTransaction();
            q('DELETE FROM list_items WHERE user_id = ? AND product_id = ? AND checked = 0', [$kid, $from]);
            q('INSERT INTO list_items (user_id, product_id, name, qty, added_by, checked) VALUES (?, ?, ?, 1, ?, ?)', [$kid, $to, $name, $uid, !empty($in['checked']) ? 1 : 0]);
            db()->commit();
            out(['replaced' => count($lines)]);

        case 'trips.add':
            q('INSERT INTO trips (trip_date, store_id, total, note, user_id, added_by) VALUES (?, ?, ?, ?, ?, ?)', [
                date_in($in, 'date', date('Y-m-d')), own_store(int_in($in, 'store_id', false)),
                num_in($in, 'total', null, 0, 1e6) ?? fail('Missing total'), str_in($in, 'note', 200), $kid, $uid,
            ]);
            out(['ok' => true]);

        case 'trips.delete':
            // your kitchen's shops, or your own takeaways
            q("DELETE FROM trips WHERE id = ? AND ((user_id = ? AND kind = 'groceries') OR (user_id = ? AND kind = 'eating_out'))", [int_in($in, 'id'), $kid, $uid]);
            out(['ok' => true]);

        case 'account.targets':
            $protein = num_in($in, 'protein_target_g', null, 0, 1000);
            $kj = num_in($in, 'kj_target', null, 0, 100000);
            q('UPDATE users SET protein_target_g = ?, kj_target = ? WHERE id = ?', [
                $protein ? (int)$protein : null, $kj ? (int)$kj : null, $uid,
            ]);
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

        case 'account.name':
            $name = str_in($in, 'display_name', 60, true);
            q('UPDATE users SET display_name = ? WHERE id = ?', [$name, $uid]);
            out(['ok' => true]);

        case 'account.export':
            // everything the app holds about you (POPIA: your right to see your information)
            $mine = fn(string $sql) => q($sql, [$uid])->fetchAll();
            out(['export' => [
                'exported_at' => date('c'),
                'account' => q('SELECT username, display_name, created_at, last_seen, protein_target_g, kj_target FROM users WHERE id = ?', [$uid])->fetch(),
                'settings' => $mine('SELECT k, v FROM user_settings WHERE user_id = ?'),
                'shops' => $mine('SELECT id, name FROM stores WHERE user_id = ?'),
                'prices' => $mine('SELECT p.name product, s.name shop, pr.price, pr.recorded_at FROM prices pr JOIN stores s ON s.id = pr.store_id JOIN products p ON p.id = pr.product_id WHERE s.user_id = ?'),
                'shopping_list' => $mine('SELECT name, qty, checked, created_at FROM list_items WHERE user_id = ?'),
                'pantry' => $mine('SELECT p.name, pa.amount, pa.bought_count, pa.last_bought FROM pantry pa JOIN products p ON p.id = pa.product_id WHERE pa.user_id = ?'),
                'meal_plan' => $mine('SELECT pl.plan_date, pl.slot, r.name recipe, pl.servings, pl.eaten_at FROM plan pl JOIN recipes r ON r.id = pl.recipe_id WHERE pl.user_id = ?'),
                'cooked_portions' => $mine('SELECT name, portions, cooked_on, location FROM fridge WHERE user_id = ?'),
                'shops_and_takeaways' => $mine('SELECT trip_date, kind, total, estimate, note FROM trips WHERE user_id = ?'),
                'pay_dates' => $mine('SELECT paid_on FROM pay_dates WHERE user_id = ?'),
                'ingredient_alerts' => $mine('SELECT code, mode FROM ingredient_alerts WHERE user_id = ?'),
                'my_recipes' => array_values(array_filter(recipes_with_costs(), fn($r) => $r['mine'])),
                'household' => household_view($uid),
                'products_you_shared_with_open_food_facts' => $mine('SELECT p.barcode, p.name, c.status, c.updated_at FROM off_contributions c JOIN products p ON p.id = c.product_id WHERE c.user_id = ?'),
                'shops_you_logged_for_your_household' => $mine('SELECT trip_date, kind, total, estimate, note FROM trips WHERE added_by = ? AND user_id <> added_by'),
            ]]);

        case 'account.delete':
            // delete the account and everything that is only yours (POPIA: your right to deletion)
            $row = q('SELECT password_hash, is_admin FROM users WHERE id = ?', [$uid])->fetch();
            if (!password_verify((string)($in['password'] ?? ''), $row['password_hash'])) {
                fail('Password is wrong');
            }
            if ((int)$row['is_admin'] === 1 && !q('SELECT 1 FROM users WHERE is_admin = 1 AND id <> ? AND disabled = 0', [$uid])->fetchColumn()) {
                fail('You run this app. Make someone else an admin first.');
            }
            db()->beginTransaction();
            leave_household($uid);
            q('DELETE FROM trips WHERE user_id = ?', [$uid]);
            q('DELETE FROM fridge WHERE user_id = ?', [$uid]);
            // private recipes go, except ones someone else still has in their plan or fridge (those stay, ownerless)
            q('DELETE r FROM recipes r WHERE r.user_id = ? AND r.is_public = 0
                 AND r.id NOT IN (SELECT recipe_id FROM (SELECT recipe_id FROM plan WHERE user_id <> ?) x)
                 AND r.id NOT IN (SELECT recipe_id FROM (SELECT recipe_id FROM fridge WHERE user_id <> ? AND recipe_id IS NOT NULL) y)', [$uid, $uid, $uid]);
            q('DELETE FROM users WHERE id = ?', [$uid]);   // the rest goes with the account (cascades)
            db()->commit();
            log_out();
            out(['ok' => true]);

        // ----- sharing products with Open Food Facts -----
        case 'off.consent':
            set_user_setting('off_share', !empty($in['share']) ? '1' : '0');
            $queued = !empty($in['share']) && ($pid = int_in($in, 'product_id', false)) ? off_queue($pid, $uid) : false;
            out(['off_share' => !empty($in['share']) ? '1' : '0', 'queued' => $queued]);

        case 'off.queue':
            user_setting('off_share', '') === '1' || fail('You chose not to share products');
            out(['queued' => off_queue(int_in($in, 'product_id'), $uid)]);

        case 'off.sync':
            // sends a few waiting products; the app calls this quietly in the background
            if (!off_ready()) {
                out(['ready' => false]);
            }
            if (!(int)db()->query("SELECT GET_LOCK('kitchen_off', 0)")->fetchColumn()) {
                out(['busy' => true]);
            }
            $done = [];
            try {
                $rows = q("SELECT product_id, user_id, attempts FROM off_contributions
                           WHERE status = 'pending' AND updated_at <= NOW() - INTERVAL (attempts * 15) MINUTE ORDER BY updated_at LIMIT 3")->fetchAll();
                foreach ($rows as $r) {
                    try {
                        $st = off_contribute((int)$r['product_id'], $r['user_id'] === null ? null : (int)$r['user_id']);
                        q('UPDATE off_contributions SET status = ?, last_error = NULL WHERE product_id = ?', [$st, $r['product_id']]);
                    } catch (Throwable $e) {
                        $tries = (int)$r['attempts'] + 1;
                        q('UPDATE off_contributions SET status = ?, attempts = ?, last_error = ? WHERE product_id = ?',
                            [$tries >= 5 ? 'failed' : 'pending', $tries, mb_substr($e->getMessage(), 0, 250), $r['product_id']]);
                        $st = 'error';
                    }
                    $done[] = ['product_id' => (int)$r['product_id'], 'status' => $st];
                }
            } finally {
                db()->query("SELECT RELEASE_LOCK('kitchen_off')");
            }
            out(['done' => $done]);

        // ----- households -----
        case 'household.get':
            out(['household' => household_view($uid)]);

        case 'household.create':
            my_household($uid) && fail("You're already in a household. Leave it first.");
            $name = str_in($in, 'name', 60, true);
            db()->beginTransaction();
            // the shared kitchen belongs to a hidden account that can't log in, so no one person owns it
            q('INSERT INTO users (username, display_name, password_hash, disabled, is_kitchen) VALUES (?, ?, ?, 1, 1)',
                ['kitchen:' . bin2hex(random_bytes(8)), $name, password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT)]);
            $kitchen = (int)db()->lastInsertId();
            q('INSERT INTO households (name, kitchen_user_id, created_by) VALUES (?, ?, ?)', [$name, $kitchen, $uid]);
            q("INSERT INTO household_members (user_id, household_id, role) VALUES (?, ?, 'owner')", [$uid, (int)db()->lastInsertId()]);
            db()->commit();
            out(['household' => household_view($uid)]);

        case 'household.rename':
            $h = my_household($uid) ?: fail("You're not in a household");
            $name = str_in($in, 'name', 60, true);
            q('UPDATE households SET name = ? WHERE id = ?', [$name, $h['id']]);
            q('UPDATE users SET display_name = ? WHERE id = ? AND is_kitchen = 1', [$name, $h['kitchen_user_id']]);
            out(['household' => household_view($uid)]);

        case 'household.invite':
            $h = my_household($uid) ?: fail('Start a household first');
            (int)q('SELECT COUNT(*) FROM household_members WHERE household_id = ?', [$h['id']])->fetchColumn() >= 8 && fail('A household can have up to 8 people');
            rate_ok('invite:' . $uid, 20, 86400) || fail('That is a lot of invites for one day. Try again tomorrow.', 429);
            $tok = bin2hex(random_bytes(24));
            q('INSERT INTO household_invites (token_hash, household_id, invited_by, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL 7 DAY)', [hash('sha256', $tok), $h['id'], $uid]);
            out(['token' => $tok, 'household' => $h['name']]);

        case 'household.preview':
            $inv = invite_row((string)($in['token'] ?? ''));
            out(['household' => $inv['household'], 'inviter' => $inv['inviter'],
                 'members' => (int)q('SELECT COUNT(*) FROM household_members WHERE household_id = ?', [$inv['household_id']])->fetchColumn(),
                 'already' => (bool)my_household($uid), 'same' => ($h = my_household($uid)) && (int)$h['id'] === (int)$inv['household_id']]);

        case 'household.join':
            $inv = invite_row((string)($in['token'] ?? ''));
            if ($h = my_household($uid)) {
                fail((int)$h['id'] === (int)$inv['household_id'] ? "You're already in this household" : "You're already in a household. Leave it first, then open the link again.");
            }
            (int)q('SELECT COUNT(*) FROM household_members WHERE household_id = ?', [$inv['household_id']])->fetchColumn() >= 8 && fail('That household is full (8 people)');
            db()->beginTransaction();
            q('UPDATE household_invites SET used_at = NOW(), used_by = ? WHERE token_hash = ? AND used_at IS NULL', [$uid, $inv['token_hash']]);
            q("INSERT INTO household_members (user_id, household_id, role) VALUES (?, ?, 'member')", [$uid, $inv['household_id']]);
            db()->commit();
            out(['household' => household_view($uid)]);

        case 'household.mode':
            $h = my_household($uid) ?: fail("You're not in a household");
            $mode = (string)($in['mode'] ?? '');
            in_array($mode, ['separate', 'shared'], true) || fail('Pick separate or shared');
            db()->beginTransaction();
            if ($mode === 'shared') {
                seed_kitchen($uid, (int)$h['kitchen_user_id']);
            }
            q('UPDATE households SET mode = ? WHERE id = ?', [$mode, $h['id']]);
            db()->commit();
            out(['household' => household_view($uid)]);

        case 'household.remove':
            $h = my_household($uid) ?: fail("You're not in a household");
            $h['role'] === 'owner' || fail('Only the person who runs the household can remove people', 403);
            $target = int_in($in, 'user_id');
            $target === $uid && fail('To leave, use Leave household');
            q('SELECT 1 FROM household_members WHERE user_id = ? AND household_id = ?', [$target, $h['id']])->fetchColumn() || fail('Not in your household', 404);
            leave_household($target);
            out(['household' => household_view($uid)]);

        case 'household.leave':
            db()->beginTransaction();
            leave_household($uid);
            db()->commit();
            out(['household' => null]);

        case 'admin.users':
            empty($user['is_admin']) && fail('Admins only', 403);
            out(['users' => q('SELECT u.id, u.username, u.display_name, u.created_at, u.last_seen, u.is_admin, u.disabled,
                                      (SELECT COUNT(*) FROM recipes r WHERE r.user_id = u.id) recipes,
                                      (SELECT COUNT(*) FROM trips t WHERE t.user_id = u.id) trips
                               FROM users u WHERE u.is_kitchen = 0 ORDER BY u.created_at')->fetchAll(),
                'off' => off_ready() ? q('SELECT status, COUNT(*) n FROM off_contributions GROUP BY status')->fetchAll(PDO::FETCH_KEY_PAIR) : null,
                'signups_open' => setting('signups_open', '1') === '1']);

        case 'admin.reset':
            // a one-time link (24 hours) to set a new password; send it to them yourself
            empty($user['is_admin']) && fail('Admins only', 403);
            $target = int_in($in, 'user_id');
            q('SELECT 1 FROM users WHERE id = ? AND is_kitchen = 0', [$target])->fetchColumn() || fail('No such person', 404);
            $tok = bin2hex(random_bytes(24));
            q('DELETE FROM password_resets WHERE user_id = ?', [$target]);
            q('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL 1 DAY)', [hash('sha256', $tok), $target]);
            out(['token' => $tok]);

        case 'admin.disable':
            empty($user['is_admin']) && fail('Admins only', 403);
            $target = int_in($in, 'user_id');
            $target === $uid && fail("You can't switch off your own account");
            q('UPDATE users SET disabled = ? WHERE id = ?', [!empty($in['disabled']) ? 1 : 0, $target]);
            if (!empty($in['disabled'])) {
                q('DELETE FROM auth_tokens WHERE user_id = ?', [$target]);
            }
            out(['ok' => true]);

        case 'admin.admin':
            empty($user['is_admin']) && fail('Admins only', 403);
            $target = int_in($in, 'user_id');
            $target === $uid && fail('You are already an admin');
            q('UPDATE users SET is_admin = ? WHERE id = ?', [!empty($in['admin']) ? 1 : 0, $target]);
            out(['ok' => true]);

        case 'admin.signups':
            empty($user['is_admin']) && fail('Admins only', 403);
            set_setting('signups_open', !empty($in['open']) ? '1' : '0');
            out(['signups_open' => !empty($in['open'])]);

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
