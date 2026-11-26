'use strict';

/* ---------- basics ---------- */
let CSRF = document.querySelector('meta[name=csrf]').content;
const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const titleEl = document.getElementById('title');
const pill = document.getElementById('budgetPill');
const meBtn = document.getElementById('meBtn');
meBtn.addEventListener('click', () => { location.hash = '#me'; });

/* South African phones type a decimal comma, and a type="number" field silently drops "12,50".
   So every number field becomes a text field with a decimal keypad, and a comma turns into a point as you type. */
function fixNumberInputs(root) {
  if (!root || !root.querySelectorAll) return;
  const els = root.matches && root.matches('input[type=number]') ? [root] : root.querySelectorAll('input[type=number]');
  els.forEach((el) => {
    const whole = el.getAttribute('step') === '1';
    el.type = 'text';
    el.inputMode = whole ? 'numeric' : 'decimal';
    el.autocomplete = 'off';
    el.dataset.num = whole ? 'int' : 'dec';
  });
}
fixNumberInputs(document);
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) fixNumberInputs(n); })
  .observe(document.body, { childList: true, subtree: true });
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !(el.dataset.num || el.inputMode === 'decimal') || !/[,\s]/.test(el.value)) return;
  const pos = el.selectionStart;
  const before = el.value.length;
  el.value = el.value.replace(/\s/g, '').replace(/,/g, '.');
  try { el.setSelectionRange(pos - (before - el.value.length), pos - (before - el.value.length)); } catch { /* not focusable */ }
}, true);

const S = { user: null, users: [], stores: [], budget: 0, spent: 0, month: '', products: [], storeId: null, aisles: [] };
const UNITS = ['each', 'g', 'kg', 'ml', 'l'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
// [key, name as on a South African label, unit, "of which" row (part of the row above it), optional row]
const NUTRIENTS = [
  ['energy_kj', 'Energy', 'kJ'], ['protein_g', 'Protein', 'g'],
  ['carbs_g', 'Carbohydrate', 'g'], ['sugar_g', 'of which total sugar', 'g', true],
  ['fat_g', 'Total fat', 'g'], ['satfat_g', 'of which saturated fat', 'g', true], ['transfat_g', 'of which trans fat', 'g', true, true],
  ['monofat_g', 'of which mono-unsaturated fat', 'g', true, true], ['polyfat_g', 'of which poly-unsaturated fat', 'g', true, true],
  ['cholesterol_mg', 'Cholesterol', 'mg', false, true], ['fibre_g', 'Dietary fibre', 'g'], ['sodium_mg', 'Total sodium', 'mg'],
];

/* ---------- health ---------- */
/** Rand per 10 g of protein for a pack at a price (needs protein per 100 g, or per item for 'each'). */
function proteinCost(p, price) {
  if (!p || price === null || price === undefined || !(p.protein_g > 0) || !(p.pack_size > 0)) return null;
  const grams = { g: 1, kg: 1000, ml: 1, l: 1000 }[p.unit];
  const protein = grams ? (p.protein_g * p.pack_size * grams) / 100 : p.protein_g * p.pack_size;
  return protein > 0 ? (price / protein) * 10 : null;
}
/** Share of the energy that comes from protein (17 kJ per g). */
const proteinShare = (p) => (p.energy_kj > 0 && p.protein_g > 0 ? Math.min(1, (17 * p.protein_g) / p.energy_kj) : 0);
const proteinLabel = (v) => (v === null ? '' : `${money(v)} per 10 g protein`);
const NOVA = { 1: 'Unprocessed', 2: 'Cooking ingredient', 3: 'Processed', 4: 'Ultra-processed' };
/* ----- Nutri-Score, worked out from the label (2023 algorithm, as published by Santé publique France).
   Open Food Facts' own grade always wins; ours fills the gap and is marked as estimated. ----- */
const NS_STEP = (v, limits, strict = true) => { let pts = 0; for (const l of limits) if (strict ? v > l : v >= l) pts++; return pts; };
const NS_T = {
  energy: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350],
  satfat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  sugar: [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51],
  salt: [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4],
  protein: [2.4, 4.8, 7.2, 9.6, 12, 14, 17],
  fibre: [3.0, 4.1, 5.2, 6.3, 7.4],
  satEnergy: [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200],
  bevEnergy: [30, 90, 150, 210, 240, 270, 300, 330, 360, 390],
  bevSugar: [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11],
  bevProtein: [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0],
};
const FVL_WORDS = /\b(tomato|carrot|onion|pea|peas|bean|beans|lentil|chickpea|potato|pumpkin|butternut|spinach|cabbage|pepper|mushroom|corn|maize kernels|apple|orange|banana|mango|pineapple|grape|peach|pear|berry|berries|strawberr|apricot|guava|lemon|fruit|vegetable)/i;
const SWEETENER_CODES = new Set(['e950', 'e951', 'e952', 'e954', 'e955', 'e957', 'e959', 'e960', 'e960a', 'e961', 'e962', 'e969']);
/** Which Nutri-Score rules apply: from the aisle, the name and whether it's sold by volume. */
function nsCategory(p) {
  const n = `${p.name || ''} ${p.brand || ''}`.toLowerCase();
  const byVolume = ['ml', 'l'].includes(p.unit);
  const drinkWords = /\b(water|juice|cooldrink|cool drink|soda|cola|lemonade|iced tea|ice tea|drink|nectar|milk|maas|amasi|kefir|smoothie|energy|squash|cordial)\b/;
  if (/\b(oil|margarine|ghee|lard|butter(?!milk| ?nut)|peanut butter|nuts?|almonds?|cashews?|peanuts?|walnuts?|macadamia|pecans?|seeds?)\b/.test(n) && !/\bbutternut\b/.test(n)) return 'fats';
  if (byVolume && drinkWords.test(n) && !/\b(sauce|dressing|vinegar|syrup|yoghurt|yogurt)\b/.test(n)) {
    if (/\b(still|sparkling|mineral|spring|table)?\s*water\b/.test(n) && !/\b(flavou?red|vitamin|tonic|coconut)\b/.test(n) && !(p.sugar_g > 0.5) && !(p.energy_kj > 20)) return 'water';
    return 'beverage';
  }
  if (/\bchees/.test(n) && !/\b(curls|puffs|naks|snack)\b/.test(n)) return 'cheese';
  if (/\b(beef|mince|lamb|mutton|pork|bacon|ham|boerewors|wors|biltong|salami|polony|vienna|venison)\b/.test(n)) return 'redmeat';
  return 'general';
}
/** Fruit, vegetable and legume share, from percentages printed in the ingredients ("Tomatoes (34%)"). 0 when not stated. */
function nsFvl(p) {
  // oils pressed from a fruit count as fruit (olive, avocado); seed and nut oils don't
  if (/\b(olive|avocado) oil\b/i.test(p.name || '')) return 100;
  let pct = 0;
  for (const part of String(p.ingredients || '').split(/[,;]/)) {
    const m = part.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (m && FVL_WORDS.test(part)) pct += parseFloat(m[1].replace(',', '.'));
  }
  return Math.min(100, pct);
}
/** Our Nutri-Score: { grade, score, category, parts: [[label, points]] } or { missing: [...] } when the label is incomplete. */
function estimateNutriScore(p) {
  const cat = nsCategory(p);
  if (cat === 'water') return { grade: 'a', score: 0, category: cat, parts: [] };
  const need = [['energy_kj', 'energy'], ['sugar_g', 'sugar'], ['satfat_g', 'saturated fat'], ['sodium_mg', 'sodium'], ['protein_g', 'protein']];
  const missing = need.filter(([k]) => p[k] === null || p[k] === undefined || p[k] === '').map(([, l]) => l);
  if (cat === 'fats' && (p.fat_g === null || p.fat_g === undefined)) missing.push('fat');
  if (missing.length) return { missing, category: cat };
  const v = (k) => Number(p[k]) || 0;
  const salt = v('sodium_mg') * 2.5 / 1000;
  const fibre = v('fibre_g');
  const fvl = nsFvl(p);
  const parts = [];
  let N = 0; let P = 0;
  const neg = (label, pts) => { N += pts; if (pts) parts.push([label, pts]); return pts; };
  const pos = (label, pts) => { if (pts) parts.push([label, -pts]); return pts; };
  if (cat === 'beverage') {
    neg('Energy', NS_STEP(v('energy_kj'), NS_T.bevEnergy));
    neg('Sugar', NS_STEP(v('sugar_g'), NS_T.bevSugar));
    neg('Saturated fat', NS_STEP(v('satfat_g'), NS_T.satfat));
    neg('Salt', NS_STEP(salt, NS_T.salt));
    const codes = new Set((p.additives || []).map((c) => String(c).toLowerCase()));
    for (const m of String(p.ingredients || '').matchAll(/\be\s?-?\s?(\d{3,4}[a-z]?)\b/gi)) codes.add(`e${m[1].toLowerCase()}`);
    const sweet = [...codes].some((c) => SWEETENER_CODES.has(c)) || /\b(aspartame|sucralose|acesulfame|saccharin|cyclamate|stevi|steviol)\b/i.test(p.ingredients || '');
    if (sweet) neg('Sweeteners', 4);
    P += pos('Protein', NS_STEP(v('protein_g'), NS_T.bevProtein));
    P += pos('Fibre', NS_STEP(fibre, NS_T.fibre));
    P += pos('Fruit and veg', fvl > 80 ? 6 : fvl > 60 ? 4 : fvl > 40 ? 2 : 0);
    const score = N - P;
    return { grade: score <= 2 ? 'b' : score <= 6 ? 'c' : score <= 9 ? 'd' : 'e', score, category: cat, parts };
  }
  if (cat === 'fats') {
    neg('Energy from saturated fat', NS_STEP(v('satfat_g') * 37, NS_T.satEnergy));
    neg('Sugar', NS_STEP(v('sugar_g'), NS_T.sugar));
    const ratio = v('fat_g') > 0 ? (v('satfat_g') / v('fat_g')) * 100 : 0;
    neg('Share of saturated fat', [10, 16, 22, 28, 34, 40, 46, 52, 58, 64].filter((l) => ratio >= l).length);
    neg('Salt', NS_STEP(salt, NS_T.salt));
  } else {
    neg('Energy', NS_STEP(v('energy_kj'), NS_T.energy));
    neg('Sugar', NS_STEP(v('sugar_g'), NS_T.sugar));
    neg('Saturated fat', NS_STEP(v('satfat_g'), NS_T.satfat));
    neg('Salt', NS_STEP(salt, NS_T.salt));
  }
  let protein = NS_STEP(v('protein_g'), NS_T.protein);
  if (cat === 'redmeat') protein = Math.min(protein, 2);
  const fib = NS_STEP(fibre, NS_T.fibre);
  const veg = fvl > 80 ? 5 : fvl > 60 ? 2 : fvl > 40 ? 1 : 0;
  const proteinCounts = cat === 'cheese' || N < (cat === 'fats' ? 7 : 11);
  if (proteinCounts) P += pos('Protein', protein);
  P += pos('Fibre', fib);
  P += pos('Fruit and veg', veg);
  const score = N - P;
  const grade = cat === 'fats'
    ? (score <= -6 ? 'a' : score <= 2 ? 'b' : score <= 10 ? 'c' : score <= 18 ? 'd' : 'e')
    : (score <= 0 ? 'a' : score <= 2 ? 'b' : score <= 10 ? 'c' : score <= 18 ? 'd' : 'e');
  return { grade, score, category: cat, parts, proteinIgnored: !proteinCounts && protein > 0 };
}
const gradeOf = (x) => { const g = nsGrade(x); return g ? g.grade : null; };
const nsBadge = (x, prefix = '') => { const g = nsGrade(x); return g ? `<span class="ns ns-${g.grade}${g.estimated ? ' est' : ''}"${g.estimated ? ' title="Estimated from the label"' : ''}>${prefix}${g.grade.toUpperCase()}</span>` : ''; };
/** The grade to show: Open Food Facts' when it has one, otherwise ours. */
function nsGrade(p) {
  if (p.nutriscore) return { grade: p.nutriscore, estimated: false };
  const e = estimateNutriScore(p);
  return e.grade ? { grade: e.grade, estimated: true, est: e } : null;
}

/** Nutri-Score, NOVA and additive badges (only what's known). */
function healthBadges(p, { long = false } = {}) {
  const out = [];
  const ns = nsGrade(p);
  if (ns) out.push(`<span class="ns ns-${ns.grade}${ns.estimated ? ' est' : ''}" title="Nutri-Score ${ns.grade.toUpperCase()}${ns.estimated ? ', estimated from the label' : ''}">${ns.grade.toUpperCase()}</span>`);
  if (p.nova) out.push(`<span class="nova nova-${p.nova}" title="NOVA ${p.nova}: ${NOVA[p.nova]}">${long ? NOVA[p.nova] : `N${p.nova}`}</span>`);
  if (p.additives && p.additives.length) out.push(`<span class="tag">${p.additives.length} additive${p.additives.length === 1 ? '' : 's'}</span>`);
  return out.length ? `<span class="badges">${out.join('')}</span>` : '';
}
/** Approximate standard values per 100 g raw/dry (eggs per egg), for loose and butchery items without a label. Source: USDA FoodData Central. */
const STANDARD_FOODS = [
  ['Chicken breast, raw, skinless', 'g', { energy_kj: 502, protein_g: 22.5, carbs_g: 0, sugar_g: 0, fat_g: 2.6, satfat_g: 0.6, fibre_g: 0, sodium_mg: 45 }],
  ['Chicken thighs, raw, with skin', 'g', { energy_kj: 925, protein_g: 16.5, carbs_g: 0, sugar_g: 0, fat_g: 16.6, satfat_g: 4.8, fibre_g: 0, sodium_mg: 74 }],
  ['Beef mince, raw (about 20% fat)', 'g', { energy_kj: 1063, protein_g: 17.2, carbs_g: 0, sugar_g: 0, fat_g: 20, satfat_g: 7.6, fibre_g: 0, sodium_mg: 66 }],
  ['Beef mince, lean, raw (about 10% fat)', 'g', { energy_kj: 736, protein_g: 20, carbs_g: 0, sugar_g: 0, fat_g: 10, satfat_g: 3.9, fibre_g: 0, sodium_mg: 66 }],
  ['Eggs, whole (per large egg)', 'each', { energy_kj: 299, protein_g: 6.3, carbs_g: 0.4, sugar_g: 0.2, fat_g: 4.8, satfat_g: 1.6, fibre_g: 0, sodium_mg: 71 }],
  ['White rice, uncooked', 'g', { energy_kj: 1527, protein_g: 7.1, carbs_g: 80, sugar_g: 0.1, fat_g: 0.7, satfat_g: 0.2, fibre_g: 1.3, sodium_mg: 5 }],
  ['Brown rice, uncooked', 'g', { energy_kj: 1548, protein_g: 7.9, carbs_g: 77, sugar_g: 0.9, fat_g: 2.9, satfat_g: 0.6, fibre_g: 3.5, sodium_mg: 7 }],
  ['Rolled oats, uncooked', 'g', { energy_kj: 1586, protein_g: 13.2, carbs_g: 67.7, sugar_g: 1, fat_g: 6.5, satfat_g: 1.1, fibre_g: 10.1, sodium_mg: 6 }],
  ['Pasta, uncooked', 'g', { energy_kj: 1552, protein_g: 13, carbs_g: 75, sugar_g: 2.7, fat_g: 1.5, satfat_g: 0.3, fibre_g: 3.2, sodium_mg: 6 }],
  ['Potatoes, raw', 'g', { energy_kj: 322, protein_g: 2, carbs_g: 17.5, sugar_g: 0.8, fat_g: 0.1, satfat_g: 0, fibre_g: 2.2, sodium_mg: 6 }],
  ['Sweet potato, raw', 'g', { energy_kj: 360, protein_g: 1.6, carbs_g: 20, sugar_g: 4.2, fat_g: 0.1, satfat_g: 0, fibre_g: 3, sodium_mg: 55 }],
  ['Broccoli, raw', 'g', { energy_kj: 142, protein_g: 2.8, carbs_g: 6.6, sugar_g: 1.7, fat_g: 0.4, satfat_g: 0, fibre_g: 2.6, sodium_mg: 33 }],
  ['Onion, raw', 'g', { energy_kj: 167, protein_g: 1.1, carbs_g: 9.3, sugar_g: 4.2, fat_g: 0.1, satfat_g: 0, fibre_g: 1.7, sodium_mg: 4 }],
  ['Milk, full cream', 'ml', { energy_kj: 255, protein_g: 3.2, carbs_g: 4.8, sugar_g: 5.1, fat_g: 3.3, satfat_g: 1.9, fibre_g: 0, sodium_mg: 43 }],
  ['Tuna, canned in water, drained', 'g', { energy_kj: 485, protein_g: 25.5, carbs_g: 0, sugar_g: 0, fat_g: 0.8, satfat_g: 0.2, fibre_g: 0, sodium_mg: 338 }],
  ['Peanut butter, smooth', 'g', { energy_kj: 2460, protein_g: 25, carbs_g: 20, sugar_g: 9, fat_g: 50, satfat_g: 10, fibre_g: 6, sodium_mg: 459 }],
];
/** Energy from the macros (kJ per g: protein 17, carbs 17, fat 37, fibre 8) vs the label. Returns a warning or ''. */
function energyCheck(n) {
  const kj = Number(n.energy_kj); const P = Number(n.protein_g) || 0; const C = Number(n.carbs_g) || 0; const F = Number(n.fat_g) || 0; const Fi = Number(n.fibre_g) || 0;
  if (!(kj > 40) || (P + C + F) === 0) return '';
  const est = 17 * P + 17 * C + 37 * F + 8 * Fi;
  if (Math.abs(est - kj) / kj <= 0.2) return '';
  const tenX = est > kj * 6 || kj > est * 6;
  return `These don't add up: ${Math.round(kj)} kJ, but the protein, carbs and fat come to about ${Math.round(est)} kJ. ${tenX ? 'A number is probably 10 times too big or small (a missing decimal point), or it\'s the per serving column.' : 'Check the numbers against the label. Some labels are simply off: if it really says this, save it as it is.'}`;
}
/** Shrink a camera photo to at most 1400 px JPEG, as base64 (no data: prefix). */
function shrinkPhoto(file, max = 1400) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't open that photo")); };
    img.src = url;
  });
}

const store = {
  get(k, d = null) { try { const v = localStorage.getItem('kb_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('kb_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* ================= DATA, OFFLINE AND SYNC =================
 * Reads (list, products, plan…) are kept in localStorage so the app still shows them with no signal.
 * Shopping-list changes made offline go into a queue, are applied to the saved copy straight away,
 * and are sent in order when the connection comes back. Each queued change has an op_id so the
 * server ignores it if it already arrived. */
const READS = new Set(['bootstrap', 'list.get', 'products.list', 'plan.get', 'recipes.list', 'fridge.list', 'budget.get', 'takeaway.get', 'diary.get']);
const QUEUEABLE = new Set(['list.add', 'list.update', 'list.delete', 'list.clear', 'list.restore', 'list.checkout', 'products.price']);
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const cacheKey = (action, data) => `kb:${action}:${JSON.stringify(data)}`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
let queue = lsGet('kb:queue', []);
let online = navigator.onLine;
let syncing = null;

class Offline extends Error { constructor() { super('No connection'); this.offline = true; } }

async function post(action, data, timeout = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch('api.php', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF': CSRF },
      body: JSON.stringify({ action, ...data }),
      signal: ctl.signal,
    });
  } catch {
    throw new Offline();
  } finally { clearTimeout(timer); }
  if (res.status === 419 && await refreshToken()) return post(action, data, timeout);
  if (res.status === 401 || res.status === 419) {
    if (queue.length) throw Object.assign(new Error('Logged out. Log in again to send your offline changes.'), { auth: true });
    location.reload(); throw new Error('Session expired');
  }
  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw Object.assign(new Error(json.error || 'Something went wrong'), { status: res.status });
  return json;
}

/** The page we booted from may be an old offline copy with an old token: fetch a fresh one. */
async function refreshToken() {
  try {
    const html = await (await fetch('./', { credentials: 'same-origin', cache: 'no-store' })).text();
    const m = html.match(/<meta name="csrf" content="([0-9a-f]+)"/);
    if (m && m[1] !== CSRF) { CSRF = m[1]; return true; }
  } catch { /* offline */ }
  return false;
}

function setOnline(v) {
  if (online !== v) { online = v; if (v) sync(); }
  netbar();
}

async function api(action, data = {}) {
  if (READS.has(action)) {
    if (queue.length) await sync();
    const key = cacheKey(action, data);
    if (!queue.length) {
      try {
        const r = await post(action, data, 10000);
        lsSet(key, r); setOnline(true);
        return r;
      } catch (er) { if (!er.offline) throw er; setOnline(false); }
    }
    const saved = lsGet(key);
    if (saved) return { ...saved, _offline: true };
    throw new Error("You're offline and this hasn't been opened with signal yet");
  }
  if (QUEUEABLE.has(action)) {
    const op = { action, data: { ...data, op_id: uuid() } };
    if (!queue.length) {
      try { const r = await post(action, op.data); setOnline(true); return r; } catch (er) { if (!er.offline) throw er; setOnline(false); }
    }
    queue.push(op); lsSet('kb:queue', queue);
    const r = applyLocal(op);
    netbar();
    sync();
    return r;
  }
  if (action === 'products.lookup') {
    try { return await post(action, data, 8000); } catch (er) {
      if (!er.offline) throw er;
      setOnline(false);
      const code = String(data.barcode || '').replace(/\D/g, '');
      const p = (lsGet(cacheKey('products.list', {}), { products: [] }).products || []).find((x) => x.barcode === code);
      return { product: p || null, barcode: code, offline: !p };
    }
  }
  try { const r = await post(action, data); setOnline(true); return r; } catch (er) {
    if (er.offline) { setOnline(false); throw new Error("You're offline. This needs a connection"); }
    throw er;
  }
}

/** Send queued changes in order. Stops at the first network failure and tries again later. */
function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const ids = lsGet('kb:ids', {});   // temporary id of an item added offline -> its real id
    let sent = 0;
    while (queue.length) {
      const op = queue[0];
      const data = { ...op.data };
      if (data.id < 0) {
        if (!ids[data.id]) { queue.shift(); lsSet('kb:queue', queue); continue; }   // its add never made it
        data.id = ids[data.id];
      }
      try {
        const r = await post(op.action, data);
        if (op.action === 'list.add' && op.tempId) { ids[op.tempId] = r.id; lsSet('kb:ids', ids); }
        sent++;
      } catch (er) {
        if (er.offline || er.auth) { setOnline(!er.offline); netbar(er.auth ? er.message : null); return; }
        toast(`Couldn't save a change: ${er.message}`);   // server said no: drop it, don't block the rest
      }
      queue.shift(); lsSet('kb:queue', queue);
      netbar();
    }
    localStorage.removeItem('kb:ids');
    setOnline(true);
    if (sent) { toast(`Synced ${sent} change${sent === 1 ? '' : 's'}`); if (typeof route === 'function' && sheet.hidden) route(); }
  })().finally(() => { syncing = null; });
  return syncing;
}

/** Apply a queued change to the saved list/products so the screen shows it straight away. */
function applyLocal(op) {
  const d = op.data;
  const lk = cacheKey('list.get', {});
  const pk = cacheKey('products.list', {});
  const list = lsGet(lk);
  const prods = lsGet(pk);
  const product = (id) => ((prods && prods.products) || []).find((p) => p.id === id);
  let out = { ok: true, _queued: true };
  if (list) {
    const items = list.items;
    const byId = (id) => items.find((i) => i.id === Number(id));
    switch (op.action) {
      case 'list.add': {
        const checked = !!d.checked;
        const pid = d.product_id ? Number(d.product_id) : null;
        const qty = Number(d.qty) || 1;
        const same = pid && items.find((i) => i.product_id === pid && i.checked === checked && (checked || !i.from_plan));
        if (same) { same.qty += qty; out = { id: same.id, _queued: true }; break; }
        const p = pid ? product(pid) : null;
        const id = -Date.now();
        op.tempId = id;
        items.push({ id, product_id: pid, name: p ? p.name : d.name, qty, checked, from_plan: false,
          unit_price: pid ? null : (d.unit_price === undefined || d.unit_price === '' ? null : Number(d.unit_price)),
          prices: p ? p.prices : {}, pack_size: p ? p.pack_size : null, unit: p ? p.unit : null, brand: p ? p.brand : null,
          category: p ? p.category : null, added_by_name: S.user ? S.user.display_name : '' });
        out = { id, _queued: true };
        break;
      }
      case 'list.update': {
        const it = byId(d.id);
        if (!it) break;
        if ('qty' in d) it.qty = Number(d.qty);
        if ('checked' in d) it.checked = !!d.checked;
        if ('price' in d) {
          if (it.product_id && d.store_id) it.prices = { ...it.prices, [d.store_id]: { price: Number(d.price) } };
          else it.unit_price = d.price === null || d.price === '' ? null : Number(d.price);
        }
        break;
      }
      case 'list.delete': list.items = items.filter((i) => i.id !== Number(d.id)); break;
      case 'list.clear': list.items = d.all ? [] : items.filter((i) => !i.checked); break;
      case 'list.restore': for (const r of d.items || []) if (!byId(r.id)) list.items.push({ ...r }); break;
      case 'list.checkout': {
        const total = Number(d.total) || 0;
        const estimate = items.filter((i) => i.checked).reduce((t, i) => t + (itemPrice(i).price || 0) * i.qty, 0);
        list.items = items.filter((i) => !i.checked);
        list.spent += total;
        out = { total, estimate, spent: list.spent, _queued: true };
        break;
      }
      default: break;
    }
    if (op.action === 'products.price') {
      for (const i of list.items) if (i.product_id === Number(d.product_id)) i.prices = { ...i.prices, [d.store_id]: { price: Number(d.price) } };
    }
    lsSet(lk, list);
  }
  if (prods && (op.action === 'products.price' || (op.action === 'list.update' && 'price' in d && d.store_id))) {
    const pid = op.action === 'products.price' ? Number(d.product_id) : (list && (list.items.find((i) => i.id === Number(d.id)) || {}).product_id);
    const p = product(pid);
    if (p) { p.prices = { ...p.prices, [d.store_id]: { price: Number(d.price) } }; lsSet(pk, prods); }
  }
  lsSet('kb:queue', queue);   // op.tempId may have been set
  return out;
}

function netbar(msg = null) {
  const bar = document.getElementById('netbar');
  if (!bar) return;
  const n = queue.length;
  const text = msg || (!online ? `Offline · showing saved data${n ? ` · ${n} change${n === 1 ? '' : 's'} waiting to sync` : ''}`
    : n ? `Syncing ${n} change${n === 1 ? '' : 's'}…` : '');
  bar.textContent = text;
  bar.hidden = !text;
  bar.classList.toggle('offline', !online);
}

window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
setInterval(() => { if (queue.length) sync(); }, 30000);
document.addEventListener('DOMContentLoaded', () => netbar());
if (queue.length) setTimeout(sync, 1500);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' }).then(async (reg) => {
    await navigator.serviceWorker.ready;
    const urls = performance.getEntriesByType('resource').map((e) => e.name).concat([...document.querySelectorAll('link[rel=stylesheet],script[src]')].map((e) => e.href || e.src));
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'cache', urls });
  }).catch(() => { /* not available (e.g. http) */ });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '—'
  : (v < 0 ? '-R' : 'R') + Math.abs(Number(v)).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const fmtQty = (v) => String(round(v, 2));
const packLabel = (p) => p && p.unit && p.unit !== 'each' ? `${fmtQty(p.pack_size)} ${p.unit}` : (p && p.pack_size > 1 ? `${fmtQty(p.pack_size)} pack` : '');
const storeName = (id) => (S.stores.find((s) => String(s.id) === String(id)) || {}).name || '—';
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const dayName = (d) => d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function fail(e) { toast(e.message || String(e)); }
/** Toast with an Undo button; `commit` runs after `ms` unless undone. */
/** Show a message with Undo. The change has already happened; undo() reverses it. */
function undoToast(msg, undo, ms = 6000) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span> <button type="button" class="toast-btn">Undo</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  let used = false;
  t.querySelector('.toast-btn').onclick = async () => {
    if (used) return;
    used = true; clearTimeout(toastTimer); t.hidden = true;
    try { await undo(); } catch (er) { fail(er); }
  };
}
/** The fields of a list row needed to put it back exactly. */
const listSnapshot = (it) => ({ id: it.id, product_id: it.product_id, name: it.name, qty: it.qty, unit_price: it.unit_price, checked: it.checked, from_plan: it.from_plan, added_by: it.added_by, created_at: it.created_at });

/** Price per kg / litre / item, for comparing pack sizes. */
function unitPrice(p, price) {
  if (price === null || price === undefined || !p || !p.pack_size) return '';
  const per = { g: [1000, 'kg'], kg: [1, 'kg'], ml: [1000, 'l'], l: [1, 'l'] }[p.unit];
  if (per) return `${money((price / p.pack_size) * per[0])}/${per[1]}`;
  return p.pack_size > 1 ? `${money(price / p.pack_size)} each` : '';
}

/* ---------- sheet (bottom drawer) ---------- */
let sheetOnClose = null;
function openSheet(html, onClose = null) {
  sheetBody.innerHTML = html;
  sheetBody.classList.remove('full');
  sheet.hidden = false;
  sheetOnClose = onClose;
  sheetBody.onclick = sheetBody.oninput = sheetBody.onchange = sheetBody.onsubmit = null;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  sheet.hidden = true;
  sheetBody.innerHTML = '';
  document.body.style.overflow = '';
  const cb = sheetOnClose;
  sheetOnClose = null;
  if (cb) cb();
}
sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) closeSheet(); });
const sheetHead = (title) => `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>`;

function askNumber(title, value, { hint = '', step = '0.01' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openSheet(`${sheetHead(title)}
      <form class="stack" id="askForm">
        ${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
        <input id="askVal" type="number" inputmode="decimal" step="${step}" min="0" value="${value ?? ''}">
        <button class="btn primary block">Save</button>
      </form>`, () => { if (!done) resolve(null); });
    const input = document.getElementById('askVal');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    sheetBody.onsubmit = (e) => {
      e.preventDefault();
      done = true;
      const v = input.value === '' ? null : Number(input.value);
      closeSheet();
      resolve(v);
    };
  });
}

/* ---------- prices ---------- */
function priceAt(prices, storeId) {
  const p = prices || {};
  if (storeId && p[storeId]) return { price: p[storeId].price, storeId: String(storeId), here: true, shared: !!p[storeId].shared, at: p[storeId].at };
  let best = null;
  for (const [sid, v] of Object.entries(p)) if (!best || v.price < best.price) best = { price: v.price, storeId: sid, here: false, shared: !!v.shared, at: v.at };
  return best || { price: null, storeId: null, here: false };
}
function itemPrice(it) {
  if (it.unit_price !== null && it.unit_price !== undefined) return { price: it.unit_price, here: true, manual: true };
  return priceAt(it.prices, S.storeId);
}

/* ---------- header pill ---------- */
function updatePill() {
  const left = S.budget - S.spent;
  if (!(S.budget > 0)) { pill.textContent = 'Set budget'; pill.className = 'pill'; return; }
  pill.textContent = `${money(left)} left`;
  pill.className = 'pill' + (left < 0 ? ' bad' : left < S.budget * 0.2 ? ' warn' : '');
}
pill.addEventListener('click', () => { location.hash = '#money'; });

/* ---------- routing ---------- */
/* Tabs follow the day: Today, Shop, Plan (with Recipes), Kitchen, Money. Me opens from the round button at the top. */
const routes = {
  today: ['Today', () => renderToday(), 'today'],
  shop: ['Shop', () => renderList(), 'shop'],
  plan: ['Meal plan', () => renderPlan(), 'plan'],
  recipes: ['Recipes', () => renderRecipes(), 'plan'],
  kitchen: ['Kitchen', () => renderProducts(), 'kitchen'],
  money: ['Money', () => renderBudget('money'), 'money'],
  me: ['Me', () => renderBudget('me'), null],
};
const OLD_TABS = { list: 'shop', products: 'kitchen', budget: 'money' };   // old links and bookmarks still land somewhere sensible
const onShop = () => location.hash === '#shop' || location.hash === '#list';
async function route(opts) {
  const keep = !!(opts && opts.keep);   // refresh in place: no "Loading…" flash, keep the scroll position
  let key = (location.hash || '#today').slice(1).split('/')[0];
  if (OLD_TABS[key]) { key = OLD_TABS[key]; history.replaceState(null, '', `#${key}`); }
  if (!routes[key]) key = 'today';
  const [title, fn, tab] = routes[key];
  titleEl.textContent = title;
  document.body.className = `route-${key}`;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  meBtn.classList.toggle('active', key === 'me');
  view.onclick = view.oninput = view.onchange = view.onsubmit = null;
  const y = window.scrollY;
  if (!keep) view.innerHTML = '<p class="empty">Loading…</p>';
  try { await fn(); } catch (e) { view.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  if (keep) window.scrollTo(0, y);
}

/* ---------- dock while typing ----------
 * While typing, the dock hides and the add bar sits on the keyboard. */
const isTyping = () => { const a = document.activeElement; return !!a && (['TEXTAREA', 'SELECT'].includes(a.tagName) || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(a.type))); };
function fitDock() {
  const typing = isTyping();
  document.body.classList.toggle('typing', typing);
  // No position correction: iOS clips fixed bars inside its phantom band, so pushing the dock down cut it off.
  // The page height fix in app.css avoids the band instead.
  document.documentElement.style.setProperty('--vp-gap', '0px');
}
['resize', 'orientationchange', 'pageshow'].forEach((ev) => window.addEventListener(ev, fitDock));
window.visualViewport?.addEventListener('resize', fitDock);
document.addEventListener('focusin', fitDock);
document.addEventListener('focusout', () => setTimeout(fitDock, 50));
fitDock();

/** One line of numbers for fixing layout on a phone I can't see: window vs screen height and safe areas. */
function displayCheck() {
  const probe = document.createElement('div');
  probe.className = 'probe';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const top = parseFloat(cs.paddingTop) || 0; const bottom = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return `Display check: window ${window.innerHeight}, screen ${screen.height}, visible ${Math.round(window.visualViewport?.height || 0)}, safe top ${top}, bottom ${bottom}, gap ${getComputedStyle(document.documentElement).getPropertyValue('--vp-gap').trim()}${standalone ? ', app' : ', browser'}`;
}

/* ---------- pull to refresh (the installed app has no reload button) ---------- */
(() => {
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';
  document.body.appendChild(ind);
  const icon = ind.firstChild;
  const THRESHOLD = 70; const MAX = 110;
  let startY = null; let startX = 0; let pull = 0; let busy = false;

  const place = (px, spin = false) => {
    ind.style.transform = `translate(-50%, ${px - 56}px)`;
    ind.style.opacity = String(Math.min(1, Math.max(0, px / THRESHOLD)));
    icon.style.transform = spin ? '' : `rotate(${px * 3}deg)`;
    ind.classList.toggle('ready', px >= THRESHOLD);
    ind.classList.toggle('spin', spin);
  };
  const reset = () => { startY = null; pull = 0; ind.classList.add('back'); place(0); setTimeout(() => ind.classList.remove('back'), 250); };

  document.addEventListener('touchstart', (e) => {
    const t = e.target;
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || !sheet.hidden
      || (t.closest && t.closest('input, textarea, select, .chips, .daystrip, #scanner'))) { startY = null; return; }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; pull = 0;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || window.scrollY > 0 || dx > dy) { if (pull) reset(); else startY = null; return; }
    pull = Math.min(MAX, dy * 0.5);
    place(pull);
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    if (pull < THRESHOLD) { reset(); return; }
    busy = true;
    place(THRESHOLD, true);
    navigator.vibrate?.(10);
    try {
      if (queue.length) await sync();
      const b = await api('bootstrap');
      Object.assign(S, { users: b.users, stores: b.stores, budget: b.budget, spent: b.spent });
      updatePill();
      await loadProducts();
      await route({ keep: true });
      toast(b._offline ? "You're offline, showing saved data" : 'Up to date');
    } catch (er) { fail(er); }
    busy = false;
    reset();
  });
  document.addEventListener('touchcancel', () => { if (startY !== null) reset(); });
  place(0);
})();
window.addEventListener('hashchange', () => { if (!sheet.hidden) closeSheet(); route(); });

async function loadProducts() {
  const r = await api('products.list');
  S.products = r.products;
  S.aisles = r.aisle_order || [];
  S.offPending = r.off_pending || 0;
  return S.products;
}

function storeSelect(id = 'storeSel', selected = S.storeId, allowNone = false) {
  return `<select id="${id}">${allowNone ? '<option value="">— no shop —</option>' : ''}${S.stores.map((s) =>
    `<option value="${s.id}" ${String(s.id) === String(selected) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}

/* ================= LIST ================= */
const ICON_USUALS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>';
const ICON_SCAN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>';
const ICON_POT = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z"/><path d="M2 11h20M9 7c0-1.5 1-2 1-3M14 7c0-1.5 1-2 1-3"/></svg>';
const money0 = (v) => (v === null || v === undefined) ? '—' : `${v < 0 ? '-' : ''}R${Math.abs(Math.round(v)).toLocaleString('en-ZA')}`;

function ringSvg(spent, list, budget) {
  const C = 2 * Math.PI * 44;
  const spentFrac = budget > 0 ? spent / budget : 1;
  const a = Math.min(1, spentFrac) * C;
  const b = budget > 0 ? Math.max(0, Math.min(C - a, (list / budget) * C)) : 0;
  const pct = Math.round(spentFrac * 100);
  const col = spentFrac > 1 ? '#ff7a6b' : spentFrac > 0.8 ? '#f0b35a' : '#d4f25c';
  return `<svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="${pct} percent of this month's budget spent">
    <circle cx="52" cy="52" r="44" fill="none" stroke="#252c29" stroke-width="10"/>
    ${b > 1 ? `<circle cx="52" cy="52" r="44" fill="none" stroke="#6e7f2c" stroke-width="10" stroke-dasharray="${b} ${C}" stroke-dashoffset="${-(a + 2)}" transform="rotate(-90 52 52)"/>` : ''}
    ${a > 0.5 ? `<circle cx="52" cy="52" r="44" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${a} ${C}" transform="rotate(-90 52 52)"/>` : ''}
    <text x="52" y="50" text-anchor="middle" fill="#eef2ee" font-family="Space Grotesk, sans-serif" font-size="20" font-weight="700">${pct}%</text>
    <text x="52" y="67" text-anchor="middle" fill="#9aa59f" font-family="Inter, sans-serif" font-size="11">spent</text>
  </svg>`;
}

async function renderList() {
  startListPoll();
  const [{ items, spent, budget, takeaway, fridge, today: todayMeals, last_shop: lastShop, period }] = await Promise.all([api('list.get'), S.products.length ? null : loadProducts()]);
  if (period) S.period = period;
  S.takeawayWeekly = takeaway.weekly;
  S.spent = spent; S.budget = budget; updatePill();

  S.lastListJson = JSON.stringify(items);
  S.listItems = items;
  const lines = items
    .map((it) => ({ it, p: itemPrice(it) }));
  const open = lines.filter(({ it }) => !it.checked);
  const done = lines.filter(({ it }) => it.checked);
  const sum = (arr) => arr.reduce((s, { it, p }) => s + (p.price || 0) * it.qty, 0);
  const listTotal = sum(lines);
  const openTotal = sum(open);
  const checkedTotal = sum(done);
  const left = budget - spent;
  const after = left - listTotal;
  const periodText = S.period && S.period.end ? `until ${fmtDay(S.period.end).replace(/^\w+ /, '')}` : `for ${new Date().toLocaleDateString('en-ZA', { month: 'long' })}`;

  // whole list priced at each shop
  const compare = S.stores.map((s) => {
    let total = 0; let known = 0; let count = 0;
    for (const { it } of lines) {
      if (it.unit_price !== null) { total += it.unit_price * it.qty; known++; count++; continue; }
      if (!it.product_id) continue;
      count++;
      const p = it.prices[s.id];
      if (p) { total += p.price * it.qty; known++; }
    }
    return { id: String(s.id), name: s.name, total, known, count };
  });
  const complete = compare.filter((c) => c.count > 0 && c.known === c.count);
  const cheapest = complete.length > 1 ? complete.reduce((a, b) => (a.total <= b.total ? a : b)).id : null;
  const where = shopCompare(lines.map(({ it }) => it));
  // items with alerts, and what the best swaps would save for the same protein
  let alertCount = 0; let swapSave = 0;
  for (const { it } of open) {
    const prod = it.product_id ? S.products.find((x) => x.id === it.product_id) : null;
    if (!prod || !analyseProduct(prod).alerts.length) continue;
    alertCount++;
    const sw = bestSwap(prod); const m = sw ? swapMaths(prod, sw) : null;
    if (m && m.saving > 0) swapSave += m.saving * it.qty;
  }
  const alertSummary = alertCount ? `<button type="button" class="alert-banner lv-amber" data-act="alerts-review"><span class="grow"><b>${alertCount} item${alertCount === 1 ? ' has an alert' : 's have alerts'}.</b>${swapSave >= 1 ? ` Swapping saves about ${money0(swapSave)} for the same protein.` : ' Tap one to see why.'}</span><span aria-hidden="true">›</span></button>` : '';

  view.innerHTML = `
    ${budget > 0 ? '' : `<a class="banner" href="#me"><b>Set your monthly grocery budget</b><span class="small">Tap your initial at the top → Money. Then this shows what's left.</span></a>`}
    ${budget > 0 && items.length ? `<p class="small shop-budget">${money0(left)} left ${esc(periodText)} · <span class="${after < 0 ? 'bad-text' : 'good-text'}">${after < 0 ? `${money0(-after)} over after this list` : `${money0(after)} after this list`}</span></p>` : ''}
    ${where ? '' : `<div class="chips" role="group" aria-label="Shop you're in">
      ${compare.map((c) => {
        const detail = !c.count ? '' : c.known === c.count ? ` · <span class="num">${money0(c.total)}</span>` : ` <span class="sub">${c.known}/${c.count}</span>`;
        return `<button type="button" class="chip ${c.id === String(S.storeId) ? 'active' : ''}" data-store="${c.id}" aria-pressed="${c.id === String(S.storeId)}">${esc(c.name)}${detail}${c.id === cheapest ? ' <span class="best">✓</span>' : ''}</button>`;
      }).join('')}
    </div>`}

    <div class="heading-row"><h1>To buy <span class="muted">${open.length}</span></h1><span class="num strong">${money(openTotal)}</span></div>
    ${alertSummary}
    ${open.length ? aisleGroups(open).map(([cat, rows]) => `${cat !== null ? `<div class="aisle">${esc(cat)}</div>` : ''}<ul class="items">${rows.map(rowHtml).join('')}</ul>`).join('')
      : `<p class="empty">${done.length ? 'Everything is in the trolley.' : 'Nothing on the list. Add items below, or plan your week and tap “Put the week on my list”.'}</p>`}

    ${done.length ? `
      <div class="divider">In the trolley · ${money(checkedTotal)}</div>
      <ul class="items done">${done.map(rowHtml).join('')}</ul>
      <button class="btn primary block" data-act="checkout">Finish shop · ${money(checkedTotal)}</button>` : ''}

    ${items.length ? `<div class="row"><button class="btn small grow" data-act="clear-checked" ${done.length ? '' : 'disabled'}>Remove ticked</button><button class="btn small danger grow" data-act="clear-all">Clear list</button></div>` : ''}

    ${(() => {
      const onList = new Set(items.filter((i) => !i.checked && i.product_id).map((i) => i.product_id));
      const low = buyAgain(onList);
      if (!low.length) return '';
      const showAll = S.buyAgainAll;
      const shown = showAll ? low : low.slice(0, 5);
      return `<section class="card stack tight buy-again"><div class="row between"><h2>Buy again</h2><span class="small muted">low or out at home</span></div>
        ${shown.map((p) => `<div class="row"><span class="grow">${esc(p.name)} <span class="small ${pantryState(p) === 'out' ? 'bad-text' : 'warn-text'}">${PANTRY_LABEL[pantryState(p)].toLowerCase()}</span></span>
          <button type="button" class="icon-btn" data-skip="${p.id}" aria-label="Not needed: hide ${esc(p.name)} until you buy it again">✕</button>
          <button type="button" class="btn small" data-addlow="${p.id}">＋ Add</button></div>`).join('')}
        ${low.length > 5 ? `<button type="button" class="linklike small" data-act="buy-again-all">${showAll ? 'Show fewer' : `Show all ${low.length}`}</button>` : ''}</section>`;
    })()}
    ${where ? whereToShopHtml(where) : ''}

    <div class="addbar">
      <div class="field">
        <input id="addInput" placeholder="Add something…" autocomplete="off" enterkeyhint="done" aria-label="Add an item">
        <div id="suggest" class="suggest" hidden></div>
      </div>
      <button class="scan alt" type="button" data-act="usuals" aria-label="Add something you've bought before">${ICON_USUALS}</button>
      <button class="scan" type="button" data-act="scan" aria-label="Scan a barcode">${ICON_SCAN}</button>
    </div>`;

  function rowHtml({ it, p }) {
    const sub = [];
    if (it.brand) sub.push(esc(it.brand));
    const pk = packLabel(it);
    if (pk) sub.push(pk);
    const up = p.price !== null && it.product_id ? unitPrice(it, p.price) : '';
    if (up && !it.checked) sub.push(up);
    if (!it.checked) {
      if (p.price === null) sub.push(`<button type="button" class="linklike hint" data-act="price">Add the ${esc(storeName(S.storeId))} price</button>`);
      else if (!p.here) sub.push(`<span class="hint">${esc(storeName(p.storeId))} price</span>`);
      else if (!p.manual) {
        const best = priceAt(it.prices, null);
        if (best.price !== null && best.price < p.price - 0.004) sub.push(`<span class="hint">${money(p.price - best.price)} cheaper at ${esc(storeName(best.storeId))}</span>`);
      }
    }
    const line = p.price === null ? null : p.price * it.qty;
    const prod = it.product_id ? S.products.find((x) => x.id === it.product_id) : null;
    const al = prod && !it.checked ? analyseProduct(prod).alerts : [];
    if (al.length) sub.unshift(`<button type="button" class="linklike ${levelClass(al[0])}-text" data-act="product">Alert: ${esc(al[0].word ? al[0].name : `${al[0].name} (${al[0].label})`)} ›</button>`);
    return `<li class="${p.price === null && !it.checked ? 'noprice' : ''} ${al.length ? `has-alert ${levelClass(al[0])}` : ''}" data-id="${it.id}">
      <input type="checkbox" data-act="check" ${it.checked ? 'checked' : ''} aria-label="${esc(it.name)}">
      <div class="grow tap" data-act="${prod ? 'product' : 'price'}">
        <div class="name">${esc(it.name)}${prod && nsGrade(prod) ? ` <span class="ns mini ns-${nsGrade(prod).grade}${nsGrade(prod).estimated ? ' est' : ''}">${nsGrade(prod).grade.toUpperCase()}</span>` : ''}${it.from_plan && !it.checked ? '<span class="tag">plan</span>' : ''}</div>
        ${sub.length ? `<div class="sub">${sub.join(' · ')}</div>` : ''}
      </div>
      <div class="item-right">
        <button class="price-btn ${line === null ? 'unknown' : ''}" data-act="price" aria-label="Price of ${esc(it.name)}">
          <div class="num">${line === null ? 'R?' : money(line)}</div>${it.qty !== 1 && p.price !== null ? `<div class="each">${money(p.price)} each</div>` : ''}
        </button>
        ${it.checked ? '' : `<div class="qty"><button data-act="dec" aria-label="One less">−</button><span>${fmtQty(it.qty)}</span><button data-act="inc" aria-label="One more">+</button></div>`}
      </div>
    </li>`;
  }

  const byId = (id) => items.find((i) => i.id === Number(id));
  const input = document.getElementById('addInput');
  const sug = document.getElementById('suggest');

  view.onchange = async (e) => {
    if (e.target.dataset.act === 'check') {
      const id = e.target.closest('li').dataset.id;
      try { await api('list.update', { id, checked: e.target.checked }); renderList(); } catch (er) { fail(er); }
    }
  };

  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { sug.hidden = true; return; }
    searchFurther(q, () => { if (input.value.trim().toLowerCase() === q) input.oninput(); });
    const matches = S.products.filter((p) => `${p.name} ${p.brand || ''}`.toLowerCase().includes(q)).slice(0, 6);
    sug.innerHTML = matches.map((p) => {
      const pr = priceAt(p.prices, S.storeId);
      return `<button data-pid="${p.id}"><span>${esc(p.name)} <span class="muted small">${esc(p.brand || '')} ${packLabel(p)}${pantryState(p) ? ` · ${PANTRY_LABEL[pantryState(p)].toLowerCase()}` : ''}</span></span><span class="num small">${pr.shared ? '≈' : ''}${money(pr.price)}</span></button>`;
    }).join('') + `<button data-new="1"><span>Add “${esc(input.value.trim())}” as a one-off</span><span class="muted">＋</span></button>`;
    sug.hidden = false;
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = sug.querySelector('button'); if (first) first.click(); }
    if (e.key === 'Escape') { sug.hidden = true; }
  };
  input.onblur = () => setTimeout(() => { sug.hidden = true; }, 200);
  // keep the focus (and the phone keyboard) in place while a suggestion is pressed: if the keyboard drops
  // mid-tap the list jumps, the finger lifts somewhere else and the tap never becomes a click
  sug.onpointerdown = (e) => e.preventDefault();
  sug.onmousedown = (e) => e.preventDefault();
  sug.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.pid) await api('list.add', { product_id: b.dataset.pid, qty: 1 });
      else await api('list.add', { name: input.value.trim(), qty: 1 });
      input.value = ''; sug.hidden = true;
      await renderList();
      document.getElementById('addInput').focus();
    } catch (er) { fail(er); }
  };

  view.onclick = async (e) => {
    const skip = e.target.closest('[data-skip]');
    if (skip) {
      const p = S.products.find((x) => x.id === Number(skip.dataset.skip));
      try { await api('pantry.set', { product_id: p.id, skip: true }); p.skip_again = true; } catch (er) { return fail(er); }
      renderList();
      undoToast(`${p.name} hidden until you buy it again`, async () => { await api('pantry.set', { product_id: p.id, skip: false }); p.skip_again = false; renderList(); });
      return;
    }
    if (e.target.closest('[data-act="buy-again-all"]')) { S.buyAgainAll = !S.buyAgainAll; return renderList(); }
    const addLow = e.target.closest('[data-addlow]');
    if (addLow) { try { await api('list.add', { product_id: addLow.dataset.addlow, qty: 1 }); } catch (er) { fail(er); } return renderList(); }
    const eat = e.target.closest('[data-eat]');
    if (eat) { try { await eatMeal(eat.dataset.eat, eat.dataset.eaten === '1'); } catch (er) { fail(er); } return renderList(); }
    const home = e.target.closest('[data-home]');
    if (home) return home.dataset.home === 'fridge' ? fridgeSheet() : takeawaySheet();
    const chip = e.target.closest('[data-store]');
    if (chip) { S.storeId = chip.dataset.store; store.set('store', S.storeId); return renderList(); }
    const el = e.target.closest('[data-act]');
    if (!el || el.dataset.act === 'check') return;
    const li = el.closest('li');
    const it = li ? byId(li.dataset.id) : null;
    try {
      switch (el.dataset.act) {
        case 'inc': await api('list.update', { id: it.id, qty: it.qty + 1 }); break;
        case 'dec':
          if (it.qty <= 1) {
            const snap = [listSnapshot(it)];
            await api('list.delete', { id: it.id });
            renderList();
            undoToast(`Removed ${it.name}`, async () => { await api('list.restore', { items: snap }); renderList(); });
            return;
          }
          await api('list.update', { id: it.id, qty: it.qty - 1 });
          break;
        case 'price': if (!(await askItemPrice(it))) return; break;
        case 'scan': return scanFlow('list');
        case 'usuals': return usualsSheet();
        case 'checkout': return checkoutSheet(checkedTotal);
        case 'product': { const pr = S.products.find((x) => x.id === it.product_id); return pr && productView(pr, { from: 'list', item: it }); }
        case 'alerts-review': {
          const first = items.filter((i) => !i.checked && i.product_id).map((i) => S.products.find((x) => x.id === i.product_id)).find((x) => x && analyseProduct(x).alerts.length);
          return first && productView(first, { from: 'list' });
        }
        case 'clear-checked':
        case 'clear-all': {
          const all = el.dataset.act === 'clear-all';
          // exactly what's on screen now; anything added later is never touched by this undo
          const snap = items.filter((i) => all || i.checked).map(listSnapshot);
          if (!snap.length) return;
          await api('list.clear', all ? { all: true } : {});
          renderList();
          undoToast(all ? `List cleared (${snap.length})` : `Removed ${snap.length} ticked`, async () => { await api('list.restore', { items: snap }); renderList(); });
          return;
        }
        default: return;
      }
      renderList();
    } catch (er) { fail(er); }
  };
}

/* ---------- Today: what am I eating, and am I on track? ---------- */
async function renderToday() {
  const todayIso = iso(new Date());
  const day = S.diaryDay && S.diaryDay <= todayIso ? S.diaryDay : todayIso;
  const isToday = day === todayIso;
  const [home, d] = await Promise.all([api('list.get'), api('diary.get', { date: day })]);
  const { spent, budget, takeaway, fridge, today: todayMeals, last_shop: lastShop, period } = home;
  if (period) S.period = period;
  S.takeawayWeekly = takeaway.weekly;
  S.spent = spent; S.budget = budget; updatePill();
  S.diary = d;
  const left = budget - spent;
  const days = S.period && S.period.days_left ? S.period.days_left : null;
  const shift = (n) => { const x = parseIso(day); x.setDate(x.getDate() + n); return iso(x); };
  const t = d.totals; const tg = d.targets;
  const bar = (label, val, target, unit) => `<div class="diary-bar">
      <div class="row between"><span>${label}</span><span class="num"><b>${fmtQty(Math.round(val))}</b>${target ? ` of ${fmtQty(target)}` : ''} ${unit}</span></div>
      ${target ? `<div class="meter ${val > target * 1.1 ? 'warn' : ''}"><div class="fill w${Math.min(10, Math.round((val / target) * 10))}"></div></div>` : ''}
    </div>`;
  const label = (e) => (e.qty_unit === 'portion' ? `${fmtQty(e.qty)} portion${e.qty === 1 ? '' : 's'}` : e.qty !== null && e.qty_unit ? ingLabel(e) : '');
  const slots = ['breakfast', 'lunch', 'dinner', 'snack'].map((sl) => [sl, d.entries.filter((e) => e.slot === sl)]).filter(([, es]) => es.length);
  view.innerHTML = `
    <div class="row day-nav">
      <button class="btn small" data-day="${shift(-1)}" aria-label="Day before">‹</button>
      <div class="grow center"><b>${isToday ? 'Today' : esc(parseIso(day).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'short' }))}</b>${isToday ? `<div class="small muted">${esc(new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>` : ''}</div>
      <button class="btn small" data-day="${shift(1)}" aria-label="Day after" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    <section class="card stack">
      ${bar('Energy', t.energy_kj, tg.energy_kj, 'kJ')}
      ${bar('Protein', t.protein_g, tg.protein_g, 'g')}
      <div class="small muted">Carbs ${fmtQty(Math.round(t.carbs_g))} g · fat ${fmtQty(Math.round(t.fat_g))} g · sugar ${fmtQty(Math.round(t.sugar_g))} g${d.unknown ? ` · <span class="warn-text">${d.unknown} without nutrition</span>` : ''}</div>
      ${!tg.energy_kj && !tg.protein_g ? '<a class="small" href="#me">Set your daily targets under Me ›</a>' : ''}
      <button class="btn primary block" data-act="ate">＋ I ate…</button>
    </section>
    ${slots.length ? `<section class="card flush diary">${slots.map(([sl, es]) => `<div class="aisle cap">${sl}</div><ul class="list">${es.map((e) => `<li data-entry="${e.id}">
        <div class="grow"><div class="name">${esc(e.name)}${e.kind === 'takeaway' ? ' <span class="tag warn">takeaway</span>' : ''}</div>
          <div class="sub">${[label(e), e.energy_kj !== null ? `${fmtQty(Math.round(e.energy_kj))} kJ` : '', e.protein_g !== null ? `${fmtQty(Math.round(e.protein_g))} g protein` : '', e.energy_kj === null && e.protein_g === null ? '<span class="muted">nutrition unknown</span>' : '', e.cost ? money(e.cost) : ''].filter(Boolean).join(' · ')}</div></div>
        <button class="icon-btn" data-del-entry="${e.id}" aria-label="Remove ${esc(e.name)}">✕</button></li>`).join('')}</ul>`).join('')}</section>`
      : `<p class="empty">${isToday ? 'Nothing logged yet today. Tick a planned meal below, or tap “I ate…”.' : 'Nothing logged on this day.'}</p>`}
    ${isToday ? `${todayHtml(todayMeals, fridge)}
    ${homeCardsHtml(fridge, takeaway, lastShop)}
    ${budget > 0 ? `<a class="card money-line" href="#money"><span class="grow"><span class="small muted">Groceries left${days ? ` · ${days} day${days === 1 ? '' : 's'} to payday` : ''}</span><b class="num ${left < 0 ? 'bad-text' : ''}">${money0(left)}</b></span><span aria-hidden="true">›</span></a>`
      : `<a class="banner" href="#me"><b>Set your monthly grocery budget</b><span class="small">Tap your initial at the top → Money.</span></a>`}` : ''}`;
  view.onclick = async (e) => {
    const dn = e.target.closest('[data-day]');
    if (dn) { S.diaryDay = dn.dataset.day; return renderToday(); }
    if (e.target.closest('[data-act=ate]')) return eatSheet(day);
    const del = e.target.closest('[data-del-entry]');
    if (del) {
      const en = d.entries.find((x) => x.id === Number(del.dataset.delEntry));
      const undoWhat = en.kind === 'fridge' || en.kind === 'plan' ? ' It goes back in the fridge.' : en.kind === 'takeaway' ? ' The takeaway spend goes too.' : '';
      if (!confirm(`Remove ${en.name} from the diary?${undoWhat}`)) return;
      try { await api('diary.delete', { id: en.id }); } catch (er) { fail(er); }
      return renderToday();
    }
    const eat = e.target.closest('[data-eat]');
    if (eat) { try { await eatMeal(eat.dataset.eat, eat.dataset.eaten === '1'); } catch (er) { fail(er); } return renderToday(); }
    const home2 = e.target.closest('[data-home]');
    if (home2) return home2.dataset.home === 'fridge' ? fridgeSheet() : takeawaySheet(() => renderToday());
  };
}

/** "I ate…": recent things, the fridge, any food or recipe, a takeaway, or quick numbers. */
async function eatSheet(day) {
  const d = S.diary || { recent: [], slot: 'snack' };
  let slot = d.slot;
  let tab = d.recent.length ? 'recent' : 'food';
  const done = async (msg) => { closeSheet(); toast(msg); renderToday(); };
  const log = async (data, msg) => {
    try { await api('diary.add', { date: day, slot, ...data }); await done(msg); } catch (er) { fail(er); }
  };
  const draw = async () => {
    let body = '';
    if (tab === 'recent') {
      body = d.recent.length ? `<ul class="list card flush">${d.recent.map((r, i) => `<li><span class="grow"><b>${esc(r.name)}</b><span class="small muted block">${r.qty_unit === 'portion' ? `${fmtQty(Number(r.qty))} portion${Number(r.qty) === 1 ? '' : 's'}` : ingLabel({ qty: Number(r.qty), qty_unit: r.qty_unit })}</span></span><button type="button" class="btn small" data-recent="${i}">Log</button></li>`).join('')}</ul>` : '<p class="muted small">Things you log often show up here for one tap.</p>';
    } else if (tab === 'fridge') {
      const { fridge } = await api('fridge.list');
      body = fridge.length ? `<ul class="list card flush">${fridge.map((f) => `<li><span class="grow"><b>${esc(f.name)}</b><span class="small muted block">${fmtQty(f.portions)} portion${f.portions === 1 ? '' : 's'}${f.location === 'freezer' ? ' · frozen' : ''}</span></span><button type="button" class="btn small" data-fridge="${f.id}" data-recipe="${f.recipe_id || ''}" data-name="${esc(f.name)}">Ate 1</button></li>`).join('')}</ul>` : '<p class="muted small">Nothing cooked in the fridge.</p>';
    } else if (tab === 'food') {
      body = `<div class="field"><input id="eatFind" placeholder="Search a food or recipe" autocomplete="off" enterkeyhint="search"></div><div id="eatResults" class="stack tight"></div>`;
    } else if (tab === 'takeaway') {
      body = `<form class="stack" id="eatTa">
        <label>What was it? <input name="name" placeholder="e.g. Nando's quarter chicken and chips"></label>
        <label>Cost (R) <input name="cost" type="number" inputmode="decimal" step="0.01" min="0" required></label>
        <div class="grid2"><label>Energy (kJ, if you know) <input name="kj" type="number" inputmode="numeric" step="1" min="0"></label><label>Protein (g) <input name="protein" type="number" inputmode="decimal" step="0.1" min="0"></label></div>
        <button class="btn primary block">Log takeaway</button>
        <p class="small muted">It counts against your takeaway allowance too.</p></form>`;
    } else {
      body = `<form class="stack" id="eatQuick">
        <label>What was it? <input name="name" required placeholder="e.g. Slice of birthday cake"></label>
        <div class="grid2"><label>Energy (kJ) <input name="kj" type="number" inputmode="numeric" step="1" min="0"></label><label>Protein (g) <input name="protein" type="number" inputmode="decimal" step="0.1" min="0"></label></div>
        <button class="btn primary block">Log it</button></form>`;
    }
    openSheet(`${sheetHead('I ate…')}
      <div class="chips" role="group" aria-label="Which meal">${['breakfast', 'lunch', 'dinner', 'snack'].map((sl) => `<button type="button" class="chip cap ${sl === slot ? 'active' : ''}" data-slot="${sl}" aria-pressed="${sl === slot}">${sl}</button>`).join('')}</div>
      <div class="chips" role="group" aria-label="What kind">${[['recent', 'Recent'], ['fridge', 'Fridge'], ['food', 'Food'], ['takeaway', 'Takeaway'], ['quick', 'Quick']].map(([k, l]) => `<button type="button" class="chip ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      ${body}`, () => {});
    sheetBody.onclick = onClick;      // openSheet clears handlers, so put them back on every redraw
    sheetBody.onsubmit = onSubmit;
    if (tab === 'food') wireFood();
  };
  const pickProduct = (p) => {
    const units = ingUnitsFor(p);
    document.getElementById('eatResults').innerHTML = `<div class="card stack"><b>${esc(p.name)}</b><span class="small muted">${esc(p.brand || '')} ${packLabel(p)}${p.energy_kj === null && p.protein_g === null ? ' · no nutrition yet, add it under Kitchen' : ''}</span>
      <div class="row"><input id="eatQty" class="grow" type="number" inputmode="decimal" step="0.001" min="0" placeholder="${units[0] === 'each' ? '1' : '100'}" aria-label="How much">
        <select id="eatUnit" aria-label="Unit">${units.map((u) => `<option value="${u}">${ING_LABEL[u] || u}</option>`).join('')}</select></div>
      <button type="button" class="btn primary block" data-logp="${p.id}">Log ${esc(p.name)}</button></div>`;
    document.getElementById('eatQty').focus();
  };
  const pickRecipe = (r) => {
    document.getElementById('eatResults').innerHTML = `<div class="card stack"><b>${esc(r.name)}</b>
      <label>Portions <input id="eatPortions" type="number" inputmode="decimal" step="0.25" min="0.25" value="1"></label>
      <button type="button" class="btn primary block" data-logr="${r.id}">Log ${esc(r.name)}</button>
      <span class="small muted">If there are portions in the fridge, they come off.</span></div>`;
  };
  const wireFood = () => {
    const find = document.getElementById('eatFind');
    const out = document.getElementById('eatResults');
    let seq = 0;
    const results = (prods, recs) => {
      out.innerHTML = [...recs.slice(0, 4).map((r) => `<button type="button" class="pick" data-rec="${r.id}"><span><b>${esc(r.name)}</b> <span class="small muted">recipe</span></span></button>`),
        ...prods.slice(0, 8).map((p) => `<button type="button" class="pick" data-prod="${p.id}"><span><b>${esc(p.name)}</b> <span class="small muted">${esc(p.brand || '')} ${packLabel(p)}</span></span></button>`)].join('')
        || '<p class="muted small">Nothing found. Use Quick for anything else.</p>';
    };
    find.oninput = () => {
      const q = find.value.trim().toLowerCase();
      if (q.length < 2) { out.innerHTML = ''; return; }
      const words = q.split(/\s+/);
      const hit = (txt) => words.every((w) => txt.toLowerCase().includes(w));
      const recs = (S.recipes || []).filter((r) => hit(r.name));
      const local = S.products.filter((p) => hit(`${p.name} ${p.brand || ''}`));
      results(local, recs);
      const mine = ++seq;
      clearTimeout(find.t);
      find.t = setTimeout(async () => {
        try {
          const { products } = await api('products.search', { q });
          if (mine !== seq) return;
          const seen = new Set(local.map((p) => p.id));
          products.forEach((p) => { if (!S.products.some((x) => x.id === p.id)) S.products.push(p); });
          results([...local, ...products.filter((p) => !seen.has(p.id))], recs);
        } catch { /* offline */ }
      }, 300);
    };
    find.focus();
  };
  if (!S.recipes) { try { S.recipes = (await api('recipes.list')).recipes; } catch { S.recipes = []; } }
  if (!S.products.length) { try { await loadProducts(); } catch { /* offline */ } }
  const onClick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.slot) { slot = b.dataset.slot; sheetBody.querySelectorAll('[data-slot]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); }); return; }
    if (b.dataset.tab) { tab = b.dataset.tab; return draw(); }
    if (b.dataset.recent !== undefined) {
      const r = d.recent[Number(b.dataset.recent)];
      if (r.product_id && r.qty_unit !== 'portion') return log({ kind: 'product', product_id: r.product_id, qty: r.qty, qty_unit: r.qty_unit }, `${r.name} logged`);
      if (r.recipe_id) return log({ kind: 'recipe', recipe_id: r.recipe_id, portions: Number(r.qty) || 1, from_fridge: true }, `${r.name} logged`);
      return log({ kind: 'quick', name: r.name }, `${r.name} logged`);
    }
    if (b.dataset.fridge) {
      try {
        if (b.dataset.recipe) await api('diary.add', { date: day, slot, kind: 'recipe', recipe_id: b.dataset.recipe, portions: 1, from_fridge: true });
        else { await api('fridge.eat', { id: b.dataset.fridge }); await api('diary.add', { date: day, slot, kind: 'quick', name: b.dataset.name }); }
        return done(`${b.dataset.name} logged`);
      } catch (er) { return fail(er); }
    }
    if (b.dataset.prod) { const p = S.products.find((x) => x.id === Number(b.dataset.prod)); return p && pickProduct(p); }
    if (b.dataset.rec) { const r = (S.recipes || []).find((x) => x.id === Number(b.dataset.rec)); return r && pickRecipe(r); }
    if (b.dataset.logp) {
      const qty = document.getElementById('eatQty').value;
      if (!(Number(qty) > 0)) return toast('How much did you have?');
      const p = S.products.find((x) => x.id === Number(b.dataset.logp));
      return log({ kind: 'product', product_id: p.id, qty, qty_unit: document.getElementById('eatUnit').value }, `${p.name} logged`);
    }
    if (b.dataset.logr) {
      const r = S.recipes.find((x) => x.id === Number(b.dataset.logr));
      return log({ kind: 'recipe', recipe_id: r.id, portions: document.getElementById('eatPortions').value || 1, from_fridge: true }, `${r.name} logged`);
    }
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'eatTa') return log({ kind: 'takeaway', name: f.name.value || 'Takeaway', cost: f.cost.value, energy_kj: f.kj.value || null, protein_g: f.protein.value || null }, 'Takeaway logged');
    if (f.id === 'eatQuick') return log({ kind: 'quick', name: f.name.value, energy_kj: f.kj.value || null, protein_g: f.protein.value || null }, `${f.name.value} logged`);
  };
  await draw();
}

/* ---------- home: meals ready + takeaways ---------- */
function homeCardsHtml(fridge, takeaway, lastShop) {
  const portions = fridge.reduce((s, f) => s + f.portions, 0);
  const frozen = fridge.filter((f) => f.location === 'freezer').reduce((s, f) => s + f.portions, 0);
  const chilled = fridge.filter((f) => f.location !== 'freezer');
  const due = chilled.reduce((m, f) => (m && m.days_left <= f.days_left ? m : f), null);
  let fridgeNote = portions ? (frozen ? `${fmtQty(frozen)} in the freezer` : `${fridge.length} batch${fridge.length === 1 ? '' : 'es'}`) : 'Cook something';
  let fridgeClass = 'muted';
  if (due && due.days_left < 0) { fridgeNote = `${esc(due.name)}: past 3 days, check it`; fridgeClass = 'bad-text'; }
  else if (due && due.days_left <= 1) { fridgeNote = `${esc(due.name)}: eat or freeze ${due.days_left === 0 ? 'today' : 'by tomorrow'}`; fridgeClass = 'warn-text'; }
  const left = takeaway.weekly - takeaway.spent;
  const days = lastShop ? Math.floor((new Date() - parseIso(lastShop)) / 86400000) : null;
  return `<div class="grid2">
      <button type="button" class="tile" data-home="fridge">
        <span class="small muted">Meals ready</span>
        <span class="big num">${fmtQty(portions)}</span>
        <span class="small ${fridgeClass}">${fridgeNote}</span>
      </button>
      <button type="button" class="tile" data-home="takeaway">
        <span class="small muted">Takeaways left this week</span>
        <span class="big num ${left < 0 ? 'bad-text' : ''}">${money0(left)}</span>
        <span class="small muted">of ${money0(takeaway.weekly)} · tap to log</span>
      </button>
    </div>
    ${days !== null && days > 7 ? `<p class="banner">No shop logged for ${days} days. Log your till slips so the budget stays honest.</p>` : ''}`;
}

function todayHtml(meals, fridge) {
  if (!meals.length) return '';
  const inFridge = {};
  for (const f of fridge) if (f.recipe_id) inFridge[f.recipe_id] = (inFridge[f.recipe_id] || 0) + f.portions;
  return `<section class="card stack">
    <div class="heading-row"><h2>Today</h2><a href="#plan" class="small">Plan</a></div>
    ${meals.map((m) => {
      const have = inFridge[m.recipe_id] || 0;
      const status = m.eaten ? '<span class="good-text">eaten</span>'
        : have >= m.servings ? '<span class="good-text">ready in the fridge</span>'
          : have > 0 ? `<span class="warn-text">only ${fmtQty(have)} in the fridge</span>` : '<span class="muted">not cooked yet</span>';
      return `<div class="meal ${m.eaten ? 'eaten' : ''}">
        <div class="grow"><div class="strong">${esc(m.recipe)}${m.servings !== 1 ? ` <span class="muted">×${fmtQty(m.servings)}</span>` : ''}</div><div class="small"><span class="muted cap">${esc(m.slot)}</span> · ${status}</div></div>
        <button type="button" class="eat-btn ${m.eaten ? 'on' : ''}" data-eat="${m.id}" data-eaten="${m.eaten ? 1 : 0}" aria-pressed="${m.eaten}" aria-label="${m.eaten ? 'Undo eaten' : 'Mark eaten'}: ${esc(m.recipe)}">✓</button>
      </div>`;
    }).join('')}
  </section>`;
}

const refreshHome = () => { if (['', '#today', '#shop', '#list', '#kitchen'].includes(location.hash)) route({ keep: true }); };

function fridgeSheet() {
  const useBy = (f) => {
    if (f.location === 'freezer') return { text: `frozen${f.moved_on ? ` ${fmtDay(f.moved_on)}` : ''} · good for months`, cls: 'muted' };
    if (f.days_left < 0) return { text: `past ${f.moved_on ? 'its 2 days since thawing' : '3 days'}: check before eating`, cls: 'bad-text' };
    if (f.days_left === 0) return { text: 'eat or freeze today', cls: 'warn-text' };
    if (f.days_left === 1) return { text: 'eat or freeze by tomorrow', cls: 'warn-text' };
    return { text: `eat by ${fmtDay(f.use_by)}`, cls: 'muted' };
  };
  const rowHtml = (f) => {
    const u = useBy(f);
    return `<li class="fridge-row" data-id="${f.id}">
      <div class="fr-top"><span class="name grow">${esc(f.name)}</span><span class="big-n num">${fmtQty(f.portions)}<span class="small muted"> left</span></span></div>
      <div class="fr-bottom">
        <span class="sub grow"><span class="${u.cls}">${u.text}</span>${f.grams_per_portion ? ` · ${f.grams_per_portion} g each` : ''}${f.cost_per_portion !== null ? ` · ${money(f.cost_per_portion)} each` : ''}</span>
        <button class="icon-btn" data-act="more" aria-label="Change or bin ${esc(f.name)}">⋯</button>
        ${f.location === 'freezer' ? '<button class="btn small" data-act="thaw">Thaw</button>' : '<button class="btn small" data-act="freeze">Freeze</button>'}
        <button class="btn small primary" data-act="eat">Ate one</button>
      </div></li>`;
  };
  const draw = (fridge) => {
    const chilled = fridge.filter((f) => f.location !== 'freezer');
    const frozen = fridge.filter((f) => f.location === 'freezer');
    openSheet(`${sheetHead('Meals ready')}
      ${fridge.length ? `
        <h3>In the fridge</h3>
        ${chilled.length ? `<ul class="list card flush">${chilled.map(rowHtml).join('')}</ul>` : '<p class="small muted">Nothing in the fridge. Thaw a portion from the freezer the night before.</p>'}
        <p class="small muted">Cooked food keeps about 3 days in the fridge (2 after thawing). Freeze what you won't get to.</p>
        ${frozen.length ? `<h3>In the freezer</h3><ul class="list card flush">${frozen.map(rowHtml).join('')}</ul>` : ''}`
        : '<p class="empty">Nothing cooked yet. Open a recipe and tap “Cooked it”, or finish cook mode.</p>'}
      <button class="btn block" data-act="add">＋ Add cooked food</button>`, refreshHome);
    sheetBody.onclick = async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const li = a.closest('li');
      const f = li ? fridge.find((x) => x.id === Number(li.dataset.id)) : null;
      try {
        if (a.dataset.act === 'eat') {
          if (f.recipe_id) await api('diary.add', { kind: 'recipe', recipe_id: f.recipe_id, portions: 1, from_fridge: true });
          else { await api('fridge.eat', { id: f.id }); await api('diary.add', { kind: 'quick', name: f.name }); }
          draw((await api('fridge.list')).fridge);
          toast("Enjoy. It's in today's diary");
        }
        if (a.dataset.act === 'freeze' || a.dataset.act === 'thaw') {
          const to = a.dataset.act === 'freeze' ? 'freezer' : 'fridge';
          let n = f.portions;
          if (f.portions > 1) {
            const v = await askNumber(`${to === 'freezer' ? 'Freeze' : 'Thaw'} how many portions of ${f.name}?`, f.portions, { hint: to === 'freezer' ? 'The rest stays in the fridge.' : 'Thawed portions keep 2 days in the fridge.', step: '1' });
            if (v === null) return fridgeSheet();
            n = Number(v);
            if (!(n > 0)) return fridgeSheet();
          }
          draw((await api('fridge.move', { id: f.id, to, n: Math.min(n, f.portions) })).fridge);
          toast(to === 'freezer' ? 'In the freezer' : 'Thawing in the fridge');
        }
        if (a.dataset.act === 'more') {
          const v = await askNumber(`${f.name}: portions left`, f.portions, { hint: 'Set to 0 if it was eaten or binned.', step: '1' });
          if (v === null) return fridgeSheet();
          draw((await api('fridge.set', { id: f.id, portions: v })).fridge);
        }
        if (a.dataset.act === 'add') addCookedSheet();
      } catch (er) { fail(er); }
    };
  };
  api('fridge.list').then((r) => draw(r.fridge)).catch(fail);
}

/** "2026-11-28" -> "Sat 28 Nov" */
function fmtDay(isoDate) {
  return parseIso(isoDate).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
}

async function addCookedSheet() {
  if (!S.recipes) S.recipes = (await api('recipes.list')).recipes;
  openSheet(`${sheetHead('Add cooked food')}
    <form class="stack" id="ckForm">
      <label>Recipe <select name="recipe_id"><option value="">Something else</option>${S.recipes.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label>
      <label>Or a name <input name="name" placeholder="Leftover curry"></label>
      <div class="grid2">
        <label>Portions <input name="portions" type="number" inputmode="decimal" min="0.5" step="0.5" value="4" required></label>
        <label>Grams each <input name="grams" type="number" inputmode="numeric" min="0"></label>
      </div>
      <label>Cooked on <input name="date" type="date" value="${iso(new Date())}"></label>
      <button class="btn primary block">Add to fridge</button>
    </form>`, () => fridgeSheet());
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('fridge.cook', { recipe_id: f.recipe_id.value || null, name: f.name.value, portions: f.portions.value, grams_per_portion: f.grams.value || null, date: f.date.value });
      closeSheet();
    } catch (er) { fail(er); }
  };
}

function takeawaySheet(onClose = refreshHome) {
  const draw = (t, fridge) => {
    const left = t.weekly - t.spent;
    const ready = fridge.filter((f) => f.location !== 'freezer' && f.days_left >= 0);
    const frozen = fridge.filter((f) => f.location === 'freezer');
    const priced = ready.filter((f) => f.cost_per_portion !== null);
    const avg = priced.length ? priced.reduce((s, f) => s + f.cost_per_portion * f.portions, 0) / priced.reduce((s, f) => s + f.portions, 0) : null;
    openSheet(`${sheetHead('Log a takeaway')}
      <div class="row between"><span class="muted">Left this week</span><b class="num ${left < 0 ? 'bad-text' : 'good-text'}">${money(left)}</b></div>
      ${ready.length ? `<section class="card stack tight prep-nudge"><b>Ready to eat at home</b>
          ${ready.slice(0, 3).map((f) => `<div class="row between small"><span>${fmtQty(f.portions)} × ${esc(f.name)}</span><span class="muted">${f.cost_per_portion !== null ? `${money(f.cost_per_portion)} each` : ''}</span></div>`).join('')}
          <span class="small accent" id="taCompare">${avg ? `A prepped meal costs about ${money(avg)}.` : ''}</span></section>`
        : frozen.length ? `<p class="small muted">Nothing in the fridge, but ${fmtQty(frozen.reduce((s, f) => s + f.portions, 0))} portion${frozen.reduce((s, f) => s + f.portions, 0) === 1 ? '' : 's'} in the freezer. Thaw one for tomorrow?</p>` : ''}
      <form class="stack" id="taForm">
        <label>Amount (R) <input name="total" type="number" inputmode="decimal" min="0" step="0.01" required></label>
        <label>Where / what <input name="note" placeholder="Nando's, pizza night…"></label>
        <label>Date <input name="date" type="date" value="${iso(new Date())}"></label>
        <button class="btn primary block">Log it</button>
      </form>
      ${t.items.length ? `<h3>This week</h3><ul class="list card flush">${t.items.map((i) => `<li><div class="grow"><div class="name">${esc(i.note || 'Takeaway')}</div><div class="sub">${esc(i.trip_date)}</div></div><b class="num">${money(i.total)}</b><button class="icon-btn" data-del="${i.id}" aria-label="Delete">✕</button></li>`).join('')}</ul>` : ''}
      <p class="small muted">Weekly allowance ${money0(t.weekly)}. Change it under Me (your initial at the top).</p>`,
    onClose);
    setTimeout(() => { const i = sheetBody.querySelector('[name=total]'); if (i) i.focus(); }, 60);
    sheetBody.oninput = (e) => {
      const c = document.getElementById('taCompare');
      if (e.target.name !== 'total' || !c || !avg) return;
      const v = Number(e.target.value);
      c.textContent = v > 0 ? `This takeaway = ${fmtQty(round(v / avg, 1))} prepped meals (about ${money(avg)} each).` : `A prepped meal costs about ${money(avg)}.`;
    };
    sheetBody.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('diary.add', { kind: 'takeaway', cost: f.total.value, name: f.note.value || 'Takeaway', date: f.date.value });
        const r = await api('takeaway.get');
        const l = r.takeaway.weekly - r.takeaway.spent;
        toast(l >= 0 ? `Logged. ${money0(l)} left this week` : `Logged. ${money0(-l)} over this week`);
        draw(r.takeaway, fridge);
      } catch (er) { fail(er); }
    };
    sheetBody.onclick = async (e) => {
      const d = e.target.closest('[data-del]');
      if (!d || !confirm('Delete this takeaway?')) return;
      try { await api('trips.delete', { id: d.dataset.del }); draw((await api('takeaway.get')).takeaway, fridge); } catch (er) { fail(er); }
    };
  };
  Promise.all([api('takeaway.get'), api('fridge.list')])
    .then(([t, f]) => draw(t.takeaway, f.fridge))
    .catch(fail);
}

/**
 * Price the whole list at every shop.
 * - Estimate: a product with no price at a shop is filled with the average of its known prices elsewhere (shown as ~).
 * - Verdict: only shops with prices for at least half the list take part, and they're compared on the
 *   items priced at all of them, so a shop doesn't look cheap just because it has fewer prices.
 */
function shopCompare(items) {
  if (!items.length || S.stores.length < 2) return null;
  const rows = S.stores.map((s) => ({ id: String(s.id), name: s.name, total: 0, known: 0, guessed: 0, common: 0 }));
  const priced = [];   // [{ qty, prices: {storeId: price} | null, fixed }]
  let unpriced = 0; let split = 0; const splitShops = new Set();
  for (const it of items) {
    if (it.unit_price !== null && it.unit_price !== undefined) { priced.push({ qty: it.qty, fixed: it.unit_price }); continue; }
    const known = Object.fromEntries(Object.entries(it.prices || {}).map(([k, v]) => [k, v.price]));
    if (!Object.keys(known).length) { unpriced++; continue; }
    priced.push({ qty: it.qty, prices: known });
  }
  if (!priced.length) return null;
  for (const it of priced) {
    if (it.fixed !== undefined) {
      for (const r of rows) { r.total += it.fixed * it.qty; r.known++; }
      split += it.fixed * it.qty;
      continue;
    }
    const vals = Object.values(it.prices);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const [bestId, bestPrice] = Object.entries(it.prices).sort((a, b) => a[1] - b[1])[0];
    split += bestPrice * it.qty; splitShops.add(bestId);
    for (const r of rows) {
      if (r.id in it.prices) { r.total += it.prices[r.id] * it.qty; r.known++; } else { r.total += avg * it.qty; r.guessed++; }
    }
  }
  const counted = priced.length;
  let eligible = rows.filter((r) => r.known > 0 && r.known >= Math.ceil(counted / 2));
  const sharedBy = (shops) => priced.filter((it) => it.fixed !== undefined || shops.every((r) => r.id in it.prices));
  let shared = sharedBy(eligible);
  if (eligible.length > 2 && !shared.some((it) => it.fixed === undefined)) {
    // nothing priced at all of them: fall back to the two shops with the most prices
    eligible = [...eligible].sort((a, b) => b.known - a.known).slice(0, 2);
    shared = sharedBy(eligible);
  }
  const sharedReal = shared.filter((it) => it.fixed === undefined).length;
  for (const r of eligible) r.common = shared.reduce((t, it) => t + (it.fixed !== undefined ? it.fixed : it.prices[r.id]) * it.qty, 0);
  const comparable = eligible.length >= 2 && sharedReal > 0;
  for (const r of rows) r.eligible = comparable && eligible.includes(r);
  rows.sort((a, b) => (b.eligible - a.eligible) || (a.eligible ? a.common - b.common : 0) || a.total - b.total);
  return { rows, counted, unpriced, split, splitShops: splitShops.size, comparable, sharedReal, eligible: eligible.length };
}

function whereToShopHtml(w) {
  const here = String(S.storeId);
  const best = w.rows[0];
  const lastEligible = w.rows.filter((r) => r.eligible).pop();
  let verdict;
  if (w.comparable) {
    const gap = lastEligible.common - best.common;
    verdict = gap >= 1
      ? `Cheapest: <b>${esc(best.name)}</b>, ${money(gap)} less than ${esc(lastEligible.name)} on the ${w.sharedReal} item${w.sharedReal === 1 ? '' : 's'} priced at ${w.eligible === 2 ? 'both' : `all ${w.eligible}`}.`
      : `${w.eligible === 2 ? 'Both shops' : 'These shops'} cost about the same on the ${w.sharedReal} item${w.sharedReal === 1 ? '' : 's'} priced at each.`;
    if (w.sharedReal < w.counted / 2) verdict += ' Add more prices to be sure.';
  } else {
    verdict = 'Not enough prices to compare shops yet. Prices get saved as you scan or type them in the shop.';
  }
  const splitSave = Math.min(...w.rows.filter((r) => !r.guessed).map((r) => r.total).concat([Infinity])) - w.split;
  return `<section class="card where" aria-label="Where to shop">
    <div class="heading-row"><h2>Where to shop</h2><span class="small muted">whole list</span></div>
    <p class="small">${verdict}</p>
    <div class="shop-rows" role="group" aria-label="Shop you're in">
      ${w.rows.map((r) => `<button type="button" class="shop-row ${r.id === here ? 'active' : ''}" data-store="${r.id}" aria-pressed="${r.id === here}">
        <span class="grow"><span class="name">${esc(r.name)}${r.id === here ? ' <span class="tag">you’re here</span>' : ''}</span>
          <span class="sub">${r.guessed ? `${r.known} of ${w.counted} priced here` : `all ${w.counted} priced here`}</span></span>
        <span class="right"><span class="num strong">${r.guessed ? '~' : ''}${money(r.total)}</span>
          <span class="small ${r === best && w.comparable ? 'good-text' : 'muted'}">${!w.comparable ? '' : r === best ? 'cheapest' : r.eligible ? `+${money(r.common - best.common)}` : 'too few prices'}</span></span>
      </button>`).join('')}
    </div>
    ${w.rows.some((r) => r.guessed) ? '<p class="small muted">~ means some prices are guessed from the other shops.</p>' : ''}
    ${w.splitShops > 1 && Number.isFinite(splitSave) && splitSave >= 1 ? `<p class="small muted">Each item at its cheapest shop: ${money(w.split)}, ${money(splitSave)} less than one shop, but that's ${w.splitShops} stops. Only worth it if you pass them anyway.</p>` : ''}
    ${w.unpriced ? `<p class="small hint">${w.unpriced} item${w.unpriced === 1 ? ' has' : 's have'} no price anywhere yet, so ${w.unpriced === 1 ? "it's" : "they're"} left out.</p>` : ''}
  </section>`;
}

/** Group open list rows by product category in the saved aisle order; uncategorised last. */
function aisleGroups(rows) {
  const order = S.aisles || [];
  const groups = new Map();
  for (const r of rows) {
    const c = (r.it.category || '').trim() || 'Other';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }
  if (groups.size === 1) return [[null, rows]];
  const rank = (c) => { const i = order.findIndex((o) => o.toLowerCase() === c.toLowerCase()); return i < 0 ? (c === 'Other' ? 1e9 : 1e6) : i; };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/* live refresh: while the list is open, pick up the other phone's changes */
let listPoll = null;
function startListPoll() {
  clearInterval(listPoll);
  listPoll = setInterval(async () => {
    if (!onShop()) { clearInterval(listPoll); return; }
    if (!sheet.hidden || document.visibilityState !== 'visible' || ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement || {}).tagName)) return;
    try {
      const r = await api('list.get');
      if (JSON.stringify(r.items) !== S.lastListJson) renderList();
    } catch { /* offline: try again next tick */ }
  }, 15000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sheet.hidden && onShop()) renderList();
});

function checkoutSheet(estimate) {
  openSheet(`${sheetHead('Finish shop')}
    <form class="stack" id="coForm">
      <p class="muted small">Ticked items come off the list and the amount is logged against this month's budget. Use the total on your till slip.</p>
      <label>Shop ${storeSelect('coStore', S.storeId, true)}</label>
      <div class="row between"><span class="muted">List estimate</span><b class="num">${money(estimate)}</b></div>
      <label>Total on the till slip (R) <input id="coTotal" type="number" inputmode="decimal" step="0.01" min="0" placeholder="${round(estimate, 2)}" required></label>
      <p class="small muted">Bought packs are added to what's at home (pantry).</p>
      <label>Date <input id="coDate" type="date" value="${iso(new Date())}"></label>
      <button class="btn primary block">Log shop</button>
    </form>`);
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('list.checkout', {
        store_id: document.getElementById('coStore').value || null,
        total: document.getElementById('coTotal').value,
        date: document.getElementById('coDate').value,
      });
      closeSheet();
      const diff = r.total - r.estimate;
      toast(Math.abs(diff) < 0.5 ? `Logged ${money(r.total)}, spot on the estimate`
        : `Logged ${money(r.total)}: ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the list estimate`);
      loadProducts();
      route();
    } catch (er) { fail(er); }
  };
}

/* ================= SCANNER ================= */
let scanControls = null;
function stopScanner() {
  if (scanControls) { try { scanControls.stop(); } catch { /* already stopped */ } scanControls = null; }
}
function openScanner(onCode) {
  openSheet(`${sheetHead('Scan barcode')}
    <div class="scanner stack">
      <div class="scan-wrap"><video id="scanVideo" playsinline muted autoplay></video><div class="scan-line" aria-hidden="true"></div></div>
      <button type="button" class="btn small" id="scanTorch" hidden aria-pressed="false">Torch</button>
      <p class="hint muted small" id="scanHint">Starting the camera…</p>
      <p class="tiny muted" id="scanState"></p>
      <form class="row" id="manualCode"><input id="codeInput" class="grow" inputmode="numeric" placeholder="Or type the barcode"><button class="btn">Go</button></form>
    </div>`, stopScanner);
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    if (navigator.vibrate) navigator.vibrate(60);
    stopScanner(); closeSheet(); onCode(code);
  };
  sheetBody.onsubmit = (e) => { e.preventDefault(); const c = document.getElementById('codeInput').value.replace(/\D/g, ''); if (c) finish(c); };
  const hint = (t) => { const h = document.getElementById('scanHint'); if (h) h.textContent = t; };
  const video = document.getElementById('scanVideo');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    hint('Camera scanning isn’t available here (it needs HTTPS). Type the barcode instead.');
    return;
  }
  // a sharp picture with the focus following the barcode: most "finicky" scans are blur
  // exactly what worked before: just the back camera. iPhones black out if the stream is reconfigured.
  const constraints = { facingMode: { ideal: 'environment' } };
  const slow = setTimeout(() => { if (!done) hint('Struggling? Add light (torch), move a little further away so it focuses, or type the number.'); }, 8000);
  const state = (t) => { const el = document.getElementById('scanState'); if (el) el.textContent = t; };
  const afterStart = (how) => {
    hint('Hold the barcode flat in the middle, about a hand’s width away.');
    const report = () => { if (!done && !sheet.hidden) state(`${how} · ${video.videoWidth}×${video.videoHeight} · ${video.paused ? 'paused' : 'live'}`); };
    report(); setTimeout(report, 1500); setTimeout(report, 4000);
    const track = video.srcObject && video.srcObject.getVideoTracks ? video.srcObject.getVideoTracks()[0] : null;
    if (track) track.addEventListener('ended', () => { if (!done) state(`${how} · camera stopped`); });
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      const btn = document.getElementById('scanTorch');
      if (!btn) return;
      btn.hidden = false;
      btn.onclick = async () => {
        const on = btn.getAttribute('aria-pressed') !== 'true';
        try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('on', on); } catch { btn.hidden = true; }
      };
    }
  };
  const failed = (err) => { clearTimeout(slow); clearTimeout(watchdog); hint(`Camera error: ${err.message || err.name}. Allow camera access in Settings, or type the barcode.`); };
  const prevStop = () => { clearTimeout(slow); clearTimeout(watchdog); };
  // a black box with no message is the worst outcome: if no picture arrives, say so
  const watchdog = setTimeout(() => {
    if (done || sheet.hidden || video.videoWidth) return;
    try { video.play(); } catch { /* not ready */ }
    setTimeout(() => { if (!done && !sheet.hidden && !video.videoWidth) hint('The camera didn’t start. Close this and open the scanner again, check Settings → Safari → Camera, or type the barcode.'); }, 2500);
  }, 5000);

  // 1. the phone's own barcode reader, where the browser has one (Android Chrome): fastest and most forgiving
  const native = async () => {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => formats.includes(f));
    if (!want.length) return false;
    const det = new window.BarcodeDetector({ formats: want });
    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    if (sheet.hidden) { stream.getTracks().forEach((t) => t.stop()); return true; }
    video.srcObject = stream;
    await video.play();
    let stopped = false;
    scanControls = { stop: () => { stopped = true; prevStop(); stream.getTracks().forEach((t) => t.stop()); } };
    afterStart('built-in reader');
    const tick = async () => {
      if (stopped || done) return;
      try { const found = await det.detect(video); if (found.length && found[0].rawValue) return finish(found[0].rawValue); } catch { /* frame not ready */ }
      setTimeout(tick, 90);
    };
    tick();
    return true;
  };
  // 2. otherwise ZXing: supermarket barcode types only, trying harder, five times as often as its default
  const zxing = () => {
    if (!window.ZXingBrowser) { hint('The scanner didn’t load. Type the barcode instead.'); return; }
    const F = ZXingBrowser.BarcodeFormat;
    const hints = new Map([[2, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E]]]);   // POSSIBLE_FORMATS only
    const reader = new ZXingBrowser.BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: 250, delayBetweenScanSuccess: 300 });
    reader.decodeFromConstraints({ video: constraints }, video, (result) => { if (result) finish(result.getText()); })
      .then((c) => {
        if (sheet.hidden || done) { c.stop(); return; }
        scanControls = { stop: () => { prevStop(); c.stop(); } };
        afterStart('zxing');
      }).catch(failed);
  };
  if ('BarcodeDetector' in window) native().then((ok) => { if (!ok) zxing(); }).catch(() => zxing());
  else zxing();
}

async function scanFlow(from) {
  openScanner(async (code) => {
    toast('Looking up…');
    try {
      const r = await api('products.lookup', { barcode: code });
      if (r.offline) {
        toast("Offline: this barcode isn't saved yet. Add it by name for now and scan it again when you have signal.");
        return;
      }
      if (r.instore) return pickProductSheet(from, "That's the shop's own label for weighed meat or deli: it holds a price, not a product. Which product is it?");
      if (r.product) {
        const known = S.products.find((x) => x.id === r.product.id) || r.product;
        if (from === 'list') return analyseProduct(known).alerts.length ? scanAlertSheet(known) : quickAddSheet(known);
        return productView(known);
      }
      const s = r.suggestion || {};
      toast(r.suggestion ? 'Found on Open Food Facts. Check the details and add a price' : 'New product. Fill in the details');
      productEditor({
        id: null, barcode: r.barcode, name: s.name || '', brand: s.brand || '', pack_size: s.pack_size || 1,
        unit: s.unit || 'each', category: '', prices: {}, ...(s.nutrition || {}),
        nutriscore: s.nutriscore || null, nova: s.nova || null, additives: s.additives || [], ingredients: s.ingredients || '',
      }, { addToList: from === 'list' });
    } catch (er) { fail(er); }
  });
}

/** Choose an existing product (for barcodes that don't identify one). */
async function pickProductSheet(from, hint) {
  await loadProducts();
  openSheet(`${sheetHead('Which product?')}
    <p class="small muted">${esc(hint)}</p>
    <input id="pkSearch" placeholder="Search your products" autocomplete="off">
    <ul class="list" id="pkList"></ul>
    <button type="button" class="btn block" data-act="new">New product</button>`);
  const draw = () => {
    const t = document.getElementById('pkSearch').value.trim().toLowerCase();
    document.getElementById('pkList').innerHTML = S.products.filter((p) => !t || `${p.name} ${p.brand || ''}`.toLowerCase().includes(t))
      .map((p) => `<li class="tap" data-pid="${p.id}"><div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${[esc(p.brand || ''), packLabel(p)].filter(Boolean).join(' · ')}</div></div></li>`).join('') || '<li class="empty">No matches.</li>';
  };
  draw();
  sheetBody.oninput = (e) => { if (e.target.id === 'pkSearch') draw(); };
  sheetBody.onclick = (e) => {
    if (e.target.closest('[data-act=new]')) { closeSheet(); return productEditor({ id: null, name: '', brand: '', barcode: '', pack_size: 1, unit: 'kg', category: 'Meat & fish', prices: {} }, { addToList: from === 'list' }); }
    const li = e.target.closest('[data-pid]');
    if (!li) return;
    const p = S.products.find((x) => x.id === Number(li.dataset.pid));
    closeSheet();
    return from === 'list' ? quickAddSheet(p) : productEditor(p);
  };
}

/** Ask for a list item's price at the shop you're in; true when one was saved. */
async function askItemPrice(it) {
  const p = itemPrice(it);
  const at = it.product_id ? ` at ${storeName(S.storeId)}` : '';
  const v = await askNumber(`Price of ${it.name}${at}`, p.here && !p.shared ? p.price : '', { hint: it.product_id ? 'Price for one pack. Saved to the product so the app learns it.' : 'Price for one.' });
  if (v === null) return false;
  await api('list.update', { id: it.id, price: v, store_id: S.storeId });
  return true;
}

function quickAddSheet(p) {
  const items = S.listItems || [];
  const open = items.filter((i) => i.product_id === p.id && !i.checked);
  const inTrolley = items.find((i) => i.product_id === p.id && i.checked);
  const want = open.reduce((n, i) => n + Number(i.qty), 0);
  const pr = priceAt(p.prices, S.storeId);
  const best = priceAt(p.prices, null);
  const cheaper = pr.here && best.price !== null && best.price < pr.price - 0.004 ? `${money(pr.price - best.price)} cheaper at ${esc(storeName(best.storeId))}` : '';
  const status = open.length ? `<p class="good-text"><b>On your list</b> · ${fmtQty(want)} wanted</p>`
    : inTrolley ? `<p class="muted">Already in the trolley (${fmtQty(inTrolley.qty)}). Adding more goes on top.</p>`
    : '<p class="muted">Not on your list.</p>';
  openSheet(`${sheetHead(p.name)}
    <form class="stack" id="qaForm">
      <p class="muted small">${[esc(p.brand || ''), packLabel(p), unitPrice(p, pr.price)].filter(Boolean).join(' · ')}</p>
      ${pr.shared ? `<p class="small muted">${money(pr.price)} is what someone else paid at ${esc(storeName(pr.storeId))} ${sinceLabel(pr.at)}. Log your shop to keep your own price.</p>` : ''}
      ${healthBadges(p, { long: true }) || proteinCost(p, pr.price) !== null ? `<p class="small">${healthBadges(p, { long: true })} ${proteinCost(p, pr.price) !== null ? `<span class="protein-cost">${proteinLabel(proteinCost(p, pr.price))}</span>` : ''}</p>` : ''}
      ${status}
      ${cheaper ? `<p class="small hint">${cheaper}</p>` : ''}
      ${p.pantry > 0 ? `<p class="small muted">${fmtAmount(p.pantry, p.unit)} already at home.</p>` : ''}
      <label>Price at ${esc(storeName(S.storeId))} (R) <input id="qaPrice" type="number" inputmode="decimal" step="0.01" min="0" value="${pr.here ? pr.price : ''}" placeholder="${pr.price !== null ? `${storeName(pr.storeId)}: ${pr.price}` : 'Shelf price'}"></label>
      <label>How many <input id="qaQty" type="number" inputmode="decimal" step="1" min="1" value="${open.length ? want : 1}"></label>
      <button class="btn primary block" data-mode="${open.length ? 'tick' : 'trolley'}">${open.length ? 'Tick it off' : 'Put it in the trolley'}</button>
      ${open.length ? '' : '<button class="btn block" data-mode="later">Add to the list for later</button>'}
      <button class="btn block ghost" type="button" data-act="edit">Edit product</button>
    </form>`);
  sheetBody.onclick = (e) => { if (e.target.closest('[data-act=edit]')) { closeSheet(); productEditor(p); } };
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const mode = (e.submitter && e.submitter.dataset.mode) || (open.length ? 'tick' : 'trolley');
    try {
      const price = document.getElementById('qaPrice').value;
      const qty = Number(document.getElementById('qaQty').value) || 1;
      if (price !== '' && S.storeId && Number(price) !== (pr.here ? pr.price : null)) await api('products.price', { product_id: p.id, store_id: S.storeId, price });
      if (mode === 'tick') {
        // tick the first open line with the scanned amount; any other open lines for it get ticked too
        await api('list.update', { id: open[0].id, qty, checked: true });
        for (const o of open.slice(1)) await api('list.delete', { id: o.id });
      } else {
        await api('list.add', { product_id: p.id, qty, checked: mode === 'trolley' });
      }
      closeSheet();
      toast(mode === 'later' ? `Added ${p.name}` : `${p.name} is in the trolley`);
      await loadProducts(); route();
    } catch (er) { fail(er); }
  };
}

/** Pick products you've scanned or bought before, to get exactly the same thing again. */
async function usualsSheet() {
  await loadProducts();
  const onList = new Map();
  for (const it of S.listItems || []) if (it.product_id && !it.checked) onList.set(it.product_id, (onList.get(it.product_id) || 0) + Number(it.qty));
  const sorted = [...S.products].sort((a, b) => (b.bought_count - a.bought_count) || String(b.last_bought || '').localeCompare(String(a.last_bought || '')) || a.name.localeCompare(b.name));
  openSheet(`${sheetHead('Bought before')}
    <input id="usSearch" placeholder="Search your products" autocomplete="off" aria-label="Search your products">
    <p class="small muted">Most-bought first. Tap ＋ to add the exact same product to the list.</p>
    <ul class="list" id="usList"></ul>`, () => renderList());
  sheetBody.classList.add('full');
  const draw = () => {
    const term = document.getElementById('usSearch').value.trim().toLowerCase();
    const rows = sorted.filter((p) => !term || `${p.name} ${p.brand || ''} ${p.category || ''}`.toLowerCase().includes(term));
    document.getElementById('usList').innerHTML = rows.map((p) => {
      const pr = priceAt(p.prices, S.storeId);
      const n = onList.get(p.id) || 0;
      const bits = [esc(p.brand || ''), packLabel(p), pr.price !== null ? `${money(pr.price)}${pr.here ? '' : ` at ${esc(storeName(pr.storeId))}`}` : 'no price',
        p.bought_count ? `bought ${p.bought_count}×` : '', pantryState(p) ? `<span class="${pantryState(p) === 'plenty' ? 'good-text' : 'warn-text'}">${PANTRY_LABEL[pantryState(p)].toLowerCase()}</span>` : ''].filter(Boolean);
      return `<li data-pid="${p.id}"><div class="grow"><div class="name">${esc(p.name)}${n ? ` <span class="tag">${fmtQty(n)} on list</span>` : ''}</div><div class="sub">${bits.join(' · ')}</div></div>
        <button type="button" class="icon-btn add-btn" data-add="${p.id}" aria-label="Add ${esc(p.name)} to the list">＋</button></li>`;
    }).join('') || `<li class="empty">${S.products.length ? 'No matches.' : 'Nothing scanned yet. Scan products as you shop and they show up here.'}</li>`;
  };
  draw();
  sheetBody.oninput = (e) => { if (e.target.id === 'usSearch') draw(); };
  sheetBody.onclick = async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const id = Number(b.dataset.add);
    try {
      await api('list.add', { product_id: id, qty: 1 });
      onList.set(id, (onList.get(id) || 0) + 1);
      draw();
    } catch (er) { fail(er); }
  };
}

/* ================= PRODUCTS ================= */
/* ----- Kitchen: what's at home right now. The catalogue is a search away, not a list. ----- */
const HOME_PLACE = { 'Meat & fish': 'fridge', 'Dairy & eggs': 'fridge', 'Fresh produce': 'fridge', Frozen: 'freezer' };
const HOME_GROUPS = [['fridge', 'Fridge and fresh'], ['freezer', 'Freezer'], ['cupboard', 'Cupboard']];
/** Anything in the Household aisle is not food: it counts in the budget but never sits in the Kitchen. */
const isFood = (p) => (p.category || '') !== 'Household';
const FRIDGE_WORDS = /\b(chees|milk|yog|(?<!peanut |nut )butter|(?<!ice )cream|chicken|beef|mince|pork|lamb|fish|hake|salmon|egg|bacon|ham|polony|vienna|russian|boerewors|wors|hummus|lettuce|spinach|tomato(?!.*(sauce|paste|tin|can))|cucumber|berr)/i;
const FREEZER_WORDS = /\b(frozen|ice cream|ice-cream)/i;
/** Fridge, freezer or cupboard: the aisle when it says, otherwise a guess from the name. */
const homePlace = (p) => HOME_PLACE[p.category] || (p.category ? 'cupboard' : FREEZER_WORDS.test(p.name) ? 'freezer' : FRIDGE_WORDS.test(p.name) ? 'fridge' : 'cupboard');
const atHome = (p) => isFood(p) && p.pantry > 0;

async function renderProducts() {
  await loadProducts();
  view.innerHTML = `
    <div class="row">
      <input id="prodSearch" class="grow" type="search" placeholder="Find any product" value="${esc(store.get('prodSearch', '') || '')}" autocomplete="off" enterkeyhint="search">
      <button class="btn" data-act="scan" aria-label="Scan">📷</button>
      <button class="btn primary" data-act="new" aria-label="New product">＋</button>
    </div>
    <div id="offBanner"></div>
    <div id="kitchenBody" class="stack"></div>`;
  const body = document.getElementById('kitchenBody');
  let fridge = null;
  api('fridge.list').then((r) => { fridge = r.fridge; if (!document.getElementById('prodSearch').value.trim()) draw(); }).catch(() => { fridge = []; });
  const offBanner = () => {
    const n = S.offPending || 0;
    document.getElementById('offBanner').innerHTML = n ? `<button type="button" class="banner block-btn" data-act="off-refresh"><b>Get health ratings for ${n} scanned product${n === 1 ? '' : 's'}</b><span class="small">Nutri-Score, processing level and additives from Open Food Facts.</span></button>` : '';
  };
  offBanner();

  const homeRow = (p) => {
    const al = analyseProduct(p).alerts;
    return `<li class="tap ${al.length ? 'has-alert' : ''}" data-id="${p.id}"><div class="grow"><div class="name">${esc(p.name)} ${healthBadges(p)}${al.length ? ' <span class="alert-dot">!</span>' : ''}</div>
      <div class="sub">${[esc(p.brand || ''), packLabel(p)].filter(Boolean).join(' · ')}</div></div>${pantryChip(p)}</li>`;
  };
  const useSoonHtml = () => {
    if (fridge === null) return '<section class="card"><p class="small muted">Checking the fridge…</p></section>';
    if (!fridge.length) return '<button type="button" class="card fridge-line" data-act="fridge"><span class="grow"><span class="small muted">Meals ready</span><b>Nothing prepped</b></span><span aria-hidden="true">›</span></button>';
    const meals = [...fridge].sort((a, b) => (a.location === 'freezer') - (b.location === 'freezer') || (a.days_left ?? 99) - (b.days_left ?? 99));
    const when = (f) => (f.location === 'freezer' ? 'frozen' : f.days_left < 0 ? '<span class="bad-text">check before eating</span>' : f.days_left === 0 ? '<span class="warn-text">eat or freeze today</span>' : f.days_left === 1 ? '<span class="warn-text">eat by tomorrow</span>' : `eat by ${fmtDay(f.use_by)}`);
    return `<section class="card stack tight"><div class="row between"><h2>Ready to eat</h2><button type="button" class="linklike" data-act="fridge">Open ›</button></div>
      <ul class="list">${meals.slice(0, 5).map((f) => `<li class="tap" data-act="fridge"><div class="grow"><div class="name">${esc(f.name)}</div><div class="sub">${when(f)}</div></div><span class="num strong">${fmtQty(f.portions)}</span></li>`).join('')}</ul>
      ${meals.length > 5 ? `<p class="small muted">and ${meals.length - 5} more</p>` : ''}</section>`;
  };
  const homeHtml = () => {
    const home = S.products.filter(atHome).sort((a, b) => a.name.localeCompare(b.name));
    const low = home.filter((p) => pantryState(p) === 'low');
    const open = store.get('homeOpen', {}) || {};
    const groups = HOME_GROUPS.map(([k, label]) => {
      const rows = home.filter((p) => homePlace(p) === k && pantryState(p) !== 'low');
      return rows.length ? `<details class="card flush home-group" data-group="${k}" ${open[k] ? 'open' : ''}><summary><b>${label}</b><span class="muted">${rows.length}</span></summary>
        <ul class="list">${rows.map(homeRow).join('')}</ul></details>` : '';
    }).join('');
    // things that ran out lately, so a mistaken "Out" is one tap from coming back
    const lately = S.products.filter((p) => isFood(p) && pantryState(p) === 'out' && p.pantry_at && (Date.now() - new Date(String(p.pantry_at).replace(' ', 'T')).getTime()) < 14 * 86400000)
      .sort((a, b) => String(b.pantry_at).localeCompare(String(a.pantry_at))).slice(0, 8);
    const latelyHtml = lately.length ? `<details class="card flush home-group" data-group="out" ${open.out ? 'open' : ''}><summary><b>Ran out lately</b><span class="muted">${lately.length}</span></summary>
      <ul class="list">${lately.map(homeRow).join('')}</ul></details>` : '';
    return `${useSoonHtml()}
      ${low.length ? `<section class="card flush"><h2 class="pad">Running low</h2><ul class="list">${low.map(homeRow).join('')}</ul></section>` : ''}
      ${groups || (low.length ? '' : `<section class="card stack tight"><b>Nothing at home yet</b><span class="small muted">What you buy lands here when you tap <b>Done shopping</b>. Already have something? Find it above and tap <b>I have this</b>.</span></section>`)}
      ${latelyHtml}
      ${home.length ? '<p class="small muted center">Tap Plenty / Low to change how much is at home. Cooking and logging food use things up for you.</p>' : ''}`;
  };

  const sortKey = (p) => {
    const mode = store.get('prodSort', 'name');
    if (mode === 'protein') {
      const v = proteinCost(p, priceAt(p.prices, S.storeId).price);
      if (v === null) return 1e9;
      return proteinShare(p) >= 0.2 ? v : 1e6 + v;
    }
    if (mode === 'health') { const g = nsGrade(p); return (g ? g.grade.charCodeAt(0) - 96 : 6) * 10 + (p.nova || 5); }
    return 0;
  };
  const searchHtml = (term) => {
    const rows = S.products.filter((p) => `${p.name} ${p.brand || ''} ${p.category || ''} ${p.barcode || ''}`.toLowerCase().includes(term))
      .sort((a, b) => sortKey(a) - sortKey(b) || a.name.localeCompare(b.name)).slice(0, 60);
    return `<div class="chips" role="group" aria-label="Sort">
        ${[['name', 'A–Z'], ['protein', 'Cheapest protein'], ['health', 'Healthiest']].map(([k, l]) => `<button type="button" class="chip ${(store.get('prodSort', 'name') === k) ? 'active' : ''}" data-sort="${k}">${l}</button>`).join('')}
      </div>
      <section class="card flush"><ul class="list">${rows.length ? rows.map((p) => {
        const pr = priceAt(p.prices, S.storeId);
        const pc = proteinCost(p, pr.price);
        const al = analyseProduct(p).alerts;
        return `<li class="tap ${al.length ? 'has-alert' : ''}" data-id="${p.id}"><div class="grow"><div class="name">${esc(p.name)} ${healthBadges(p)}${al.length ? ' <span class="alert-dot">!</span>' : ''}</div>
          <div class="sub">${[esc(p.brand || ''), packLabel(p), atHome(p) ? `<span class="accent">${PANTRY_LABEL[pantryState(p)].toLowerCase()}</span>` : ''].filter(Boolean).join(' · ')}</div>
          ${pc !== null ? `<div class="sub protein-cost">${proteinLabel(pc)}</div>` : ''}</div>
          <div class="right"><div class="num strong">${pr.shared ? '≈' : ''}${money(pr.price)}</div></div>
          <button type="button" class="icon-btn add-btn" data-add="${p.id}" aria-label="Add ${esc(p.name)} to the list">＋</button></li>`;
      }).join('') : '<li class="empty">Nothing found yet. Searching all products…</li>'}</ul></section>`;
  };

  const draw = () => {
    const term = document.getElementById('prodSearch').value.trim().toLowerCase();
    store.set('prodSearch', term);
    body.innerHTML = term ? searchHtml(term) : homeHtml();
  };
  draw();
  view.oninput = (e) => { if (e.target.id === 'prodSearch') { draw(); searchFurther(e.target.value, draw); } };
  body.addEventListener('toggle', (e) => {
    const g = e.target.closest && e.target.closest('[data-group]');
    if (!g) return;
    const open = store.get('homeOpen', {}) || {};
    open[g.dataset.group] = g.open; store.set('homeOpen', open);
  }, true);
  view.onclick = async (e) => {
    const chip = e.target.closest('[data-pantry]');
    if (chip) return homeSheet(S.products.find((x) => x.id === Number(chip.dataset.pantry)), draw);
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { store.set('prodSort', sortBtn.dataset.sort); return draw(); }
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'fridge') return fridgeSheet();
    if (act && act.dataset.act === 'off-refresh') {
      act.disabled = true;
      try {
        let r = { left: 1 };
        while (r.left > 0) {
          r = await api('products.refresh_off');
          act.querySelector('b').textContent = r.left ? `Checking… ${r.left} to go` : 'Done';
          if (!r.checked) break;
        }
        await loadProducts(); offBanner(); draw();
        toast('Health ratings updated');
      } catch (er) { fail(er); act.disabled = false; }
      return;
    }
    if (act && act.dataset.act === 'scan') return scanFlow('products');
    if (act && act.dataset.act === 'new') return productEditor({ id: null, name: '', brand: '', barcode: '', pack_size: 1, unit: 'each', category: '', prices: {} });
    const add = e.target.closest('[data-add]');
    if (add) {
      const p = S.products.find((x) => x.id === Number(add.dataset.add));
      api('list.add', { product_id: p.id, qty: 1 }).then(() => toast(`${p.name} added to the list`)).catch(fail);
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (li) productView(S.products.find((p) => p.id === Number(li.dataset.id)));
  };
}

function productEditor(p, { addToList = false } = {}) {
  openSheet(`${sheetHead(p.id ? 'Edit product' : 'New product')}
    <form class="stack" id="pForm">
      <label>Name <input name="name" required value="${esc(p.name)}"></label>
      <div class="grid2">
        <label>Brand <input name="brand" value="${esc(p.brand || '')}"></label>
        <label>Aisle <input name="category" list="aisleList" value="${esc(p.category || '')}" placeholder="Pick or type"><datalist id="aisleList">${(S.aisles || []).map((a) => `<option value="${esc(a)}">`).join('')}</datalist></label>
      </div>
      <div class="grid2">
        <label>Pack size <input name="pack_size" type="number" inputmode="decimal" step="0.001" min="0.001" value="${p.pack_size || 1}"></label>
        <label>Unit <select name="unit">${UNITS.map((u) => `<option ${u === p.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      </div>
      <div class="row"><label class="grow">Barcode <input name="barcode" inputmode="numeric" value="${esc(p.barcode || '')}"></label><button type="button" class="btn" data-act="scan-code">📷</button></div>

      <label>At home now (${esc(p.unit === 'each' ? 'items' : p.unit || 'each')}) <input name="pantry" type="number" inputmode="decimal" step="0.001" min="0" value="${p.pantry ? round(p.pantry, 3) : ''}" placeholder="0"></label>
      <fieldset><legend>Price per pack</legend>
        ${S.stores.map((s) => `<label>${esc(s.name)} <input name="price_${s.id}" type="number" inputmode="decimal" step="0.01" min="0" value="${p.prices && p.prices[s.id] && !p.prices[s.id].shared ? p.prices[s.id].price : ''}" ${p.prices && p.prices[s.id] && p.prices[s.id].shared ? `placeholder="≈ ${p.prices[s.id].price.toFixed(2)} (what others paid here)"` : ''}></label>`).join('') || '<p class="muted small">Add shops under Me (your initial at the top) first.</p>'}
      </fieldset>

      <fieldset class="stack"><legend id="nutLegend"></legend>
        <div class="row wrap gap">
          <button type="button" class="btn small" data-act="photo">📷 Scan the label</button>
          <button type="button" class="btn small" data-act="off">Open Food Facts</button>
          <button type="button" class="btn small" data-act="standard">Standard values</button>
        </div>
        <input type="file" id="labelFile" accept="image/*" capture="environment" hidden>
        <div id="photoBox" class="photo-box"></div>
        <div id="cropBox" class="stack tight" hidden></div>
        <p class="small muted" id="labelHint">Scan the nutrition table (then the ingredients) and the app fills this in, or type it from the label's <b>per 100 g</b> column.</p>
        <div class="label-table">${NUTRIENTS.map(([k, label, unit, sub]) => `<label class="lt-row ${sub ? 'sub' : ''}"><span class="lt-name">${label}</span><input name="n_${k}" type="number" inputmode="decimal" step="0.01" min="0" value="${p[k] ?? ''}" aria-label="${label} (${unit})"><span class="lt-unit">${unit}</span></label>`).join('')}</div>
        <p class="small warn-text" id="kjWarn" hidden></p>
        <label>Ingredients <textarea name="ingredients" rows="3" placeholder="As printed on the pack (optional)">${esc(p.ingredients || '')}</textarea></label>
        <div id="healthBox" class="small"></div>
      </fieldset>

      <button class="btn primary block">${addToList ? 'Save & add to list' : 'Save'}</button>
      ${p.id ? `<button type="button" class="btn block" data-act="to-list">Add to list</button>
        <details><summary class="muted small">Price history</summary><div id="hist" class="small"></div></details>
        <button type="button" class="btn danger block" data-act="delete">Delete product</button>` : ''}
    </form>`);
  const form = document.getElementById('pForm');
  const legend = () => { document.getElementById('nutLegend').textContent = form.unit.value === 'each' ? 'Nutrition per item' : `Nutrition per 100 ${form.unit.value === 'ml' || form.unit.value === 'l' ? 'ml' : 'g'}`; };
  legend();
  // health info that isn't typed (from Open Food Facts); additives also come from the typed ingredients
  const health = { nutriscore: p.nutriscore || null, nova: p.nova || null, additives: [...(p.additives || [])] };
  let pendingPhoto = null;   // base64 JPEG waiting for the product to be saved
  const drawHealth = () => {
    const typed = (form.ingredients.value.match(/\bE\s?-?\s?\d{3,4}[a-z]?\b/gi) || []).map((x) => `e${x.replace(/\D*(\d{3,4}[a-z]?).*/i, '$1')}`.toLowerCase());
    const adds = [...new Set([...health.additives, ...typed])].sort();
    const badges = healthBadges({ ...health, additives: adds }, { long: true });
    document.getElementById('healthBox').innerHTML = badges
      ? `${badges}${adds.length ? `<div class="muted">Additives: ${adds.map((a) => a.toUpperCase()).join(', ')}</div>` : ''}${health.nutriscore || health.nova ? '<div class="muted">Nutri-Score and processing level from Open Food Facts.</div>' : ''}`
      : '';
  };
  const drawCheck = () => {
    const n = {}; for (const [k] of NUTRIENTS) n[k] = form[`n_${k}`].value;
    // label tables are per 100 g, so numbers from a scan are always checked
    const w = form.unit.value === 'each' && !sheetBody.querySelector('input.filled, input.guessed') ? '' : energyCheck(n);
    const el = document.getElementById('kjWarn'); el.textContent = w; el.hidden = !w;
  };
  const drawPhotos = () => {
    const box = document.getElementById('photoBox');
    const saved = (p.photos || []).filter((x) => x.kind === 'label');
    box.innerHTML = pendingPhoto ? `<img src="data:image/jpeg;base64,${pendingPhoto}" alt="Label photo (not saved yet)">`
      : saved.map((x) => `<a href="photo.php?id=${x.id}" target="_blank" rel="noopener"><img src="photo.php?id=${x.id}" alt="Label photo"></a>`).join('');
    box.hidden = !box.innerHTML;
  };
  drawHealth(); drawCheck(); drawPhotos();
  sheetBody.onchange = async (e) => {
    if (e.target.name === 'unit') { legend(); drawCheck(); }
    if (e.target.id === 'labelFile' && e.target.files[0]) {
      try {
        pendingPhoto = await shrinkPhoto(e.target.files[0]);
        drawPhotos();
        if (!S.labelReader) return await readOnPhone(e.target.files[0]);
        toast('Reading the label…');
        const r = await api('label.read', { data: pendingPhoto, mime: 'image/jpeg' });
        let filled = 0;
        for (const [k] of NUTRIENTS) if (r.nutrition[k] !== null) { form[`n_${k}`].value = r.nutrition[k]; filled++; }
        if (r.ingredients && !form.ingredients.value) form.ingredients.value = r.ingredients;
        drawHealth(); drawCheck();
        toast(r.column === 'serving' ? 'Careful: that looks like the per serving column. Check against the label'
          : filled || r.ingredients ? 'Filled in from the photo. Check it against the label before saving' : "Couldn't read numbers. Try closer, straight on, no glare");
      } catch (er) { fail(er); }
    }
  };
  // read the photo on the phone: fill what it finds, mark it, and leave the checking to the person
  async function readOnPhone(file) {
    const hint = document.getElementById('labelHint');
    const was = hint.innerHTML;
    try {
      hint.textContent = 'Reading the label…';
      const scan = await ocrFindTable(file, (m) => {
        if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') hint.textContent = 'Getting the label reader ready (the first time takes a minute)…';
        else if (m.status === 'recognizing text') hint.textContent = `Looking at the photo… ${Math.round((m.progress || 0) * 100)}%`;
      });
      const text = scan.text;
      let table = '';
      const ingredientsOnly = !scan.box && extractIngredients(text);
      if (!ingredientsOnly) {
        hint.innerHTML = '<b>Check the box.</b>';
        const cropHost = document.getElementById('cropBox');
        const box = await cropPicker(cropHost, scan.bmp, scan.box);
        cropHost.hidden = true; cropHost.innerHTML = '';
        if (!box) { hint.innerHTML = was; return; }
        table = await ocrReadPart(scan.bmp, box, (n, of) => { hint.textContent = `Reading the nutrition table (${n} of ${of})…`; });
      }
      // the chosen table, read several times and voted on; without one, the whole photo
      const parsed = table ? voteLabels(table) : parseLabelText(text);
      const ingredients = extractIngredients(text) || (table ? extractIngredients(table.join('\n')) : '');
      const { values, servingFirst, found, guessed } = parsed;
      for (const el of sheetBody.querySelectorAll('.filled, .guessed')) el.classList.remove('filled', 'guessed');
      let filled = 0;
      if (found >= 2) {
        for (const [k, v] of Object.entries(values)) {
          const el = form[`n_${k}`];
          if (el) { el.value = Math.round(v * 100) / 100; el.classList.add(guessed.includes(k) ? 'guessed' : 'filled'); filled++; }
        }
      }
      if (ingredients && (!form.ingredients.value || filled === 0)) { form.ingredients.value = ingredients; form.ingredients.classList.add('filled'); }
      drawHealth(); drawCheck();
      const missing = NUTRIENTS.filter(([k, , , , optional]) => !optional && !(k in values)).map(([, l]) => l.replace(/^of which /, '').toLowerCase());
      hint.innerHTML = filled
        ? `<b>Read ${filled} rows from the photo${servingFirst ? ' (the per 100 g column)' : ''}.</b> Check the highlighted numbers against the label before saving.`
          + (guessed.length ? ' <span class="warn-text">Orange ones were worked out from the per serving column.</span>' : '')
          + (missing.length ? ` Not read: ${missing.join(', ')}.${filled < 6 ? ' A closer photo, with the table filling the screen, reads more.' : ''}` : '')
          + (form.unit.value === 'each' ? ' <span class="warn-text">These are per 100 g: set the unit to g or ml and the pack size above.</span>' : '')
          + (ingredients ? '' : ' Scan the ingredients list too.')
        : ingredients ? '<b>Ingredients filled in from the photo.</b> Check them before saving.'
          : "<b>Couldn't read it.</b> Get closer so the table fills the screen, hold the phone straight above it, avoid glare, or type the numbers.";
    } catch (er) {
      hint.innerHTML = was; fail(er);
    }
  }
  sheetBody.oninput = (e) => {
    if (e.target.classList) e.target.classList.remove('filled', 'guessed');
    if (e.target.name && e.target.name.startsWith('n_')) drawCheck();
    if (e.target.name === 'ingredients') drawHealth();
  };

  if (p.id) {
    api('products.history', { id: p.id }).then(({ history }) => {
      const el = document.getElementById('hist');
      if (el) el.innerHTML = history.length ? history.map((h) => `<div class="row"><span class="grow">${esc(h.recorded_at.slice(0, 10))} · ${esc(h.store)}${h.who ? ` · ${esc(h.who)}` : ''}</span><span class="num">${money(Number(h.price))}</span></div>`).join('') : '<p class="muted">No prices yet.</p>';
    }).catch(() => {});
  }

  sheetBody.onclick = async (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    try {
      if (act.dataset.act === 'scan-code') {
        const snapshot = { ...collect(), ...Object.fromEntries(NUTRIENTS.map(([k]) => [k, form[`n_${k}`].value])) };
        closeSheet();
        openScanner((code) => productEditor({ ...p, ...snapshot, barcode: code }, { addToList }));
      } else if (act.dataset.act === 'off') {
        const code = form.barcode.value.replace(/\D/g, '');
        if (!code) return toast('Add a barcode first');
        toast('Checking Open Food Facts…');
        const { suggestion: s } = await api('products.off', { barcode: code });
        if (!s) return toast('Not found on Open Food Facts');
        if (!form.name.value && s.name) form.name.value = s.name;
        if (!form.brand.value && s.brand) form.brand.value = s.brand;
        if (!s.has_nutrition) {
          Object.assign(health, { nutriscore: s.nutriscore || health.nutriscore, nova: s.nova || health.nova, additives: s.additives && s.additives.length ? s.additives : health.additives });
          if (s.ingredients && !form.ingredients.value) form.ingredients.value = s.ingredients;
          drawHealth();
          return toast('Found, but no nutrition info listed');
        }
        Object.assign(health, { nutriscore: s.nutriscore || health.nutriscore, nova: s.nova || health.nova, additives: s.additives && s.additives.length ? s.additives : health.additives });
        if (s.ingredients && !form.ingredients.value) form.ingredients.value = s.ingredients;
        drawHealth();
        for (const [k] of NUTRIENTS) if (s.nutrition[k] !== null) form[`n_${k}`].value = s.nutrition[k];
        drawCheck();
        toast('Nutrition filled in. Check it against the label');
      } else if (act.dataset.act === 'photo') {
        document.getElementById('labelFile').click();
      } else if (act.dataset.act === 'standard') {
        const unit = form.unit.value === 'each' ? 'each' : (['ml', 'l'].includes(form.unit.value) ? 'ml' : 'g');
        const options = STANDARD_FOODS.filter(([, u]) => u === unit);
        if (!options.length) return toast(unit === 'each' ? 'Standard values per item: only eggs. Switch the unit to see the rest' : 'No standard values for this unit');
        const box = document.getElementById('photoBox');
        box.hidden = false;
        box.innerHTML = `<label>Closest match <select id="stdPick"><option value="">Pick a food…</option>${options.map(([name], i) => `<option value="${i}">${esc(name)}</option>`).join('')}</select></label>
          <p class="small muted">Approximate values (USDA) for loose and butchery food. Raw or uncooked weight, so weigh before cooking.</p>`;
        document.getElementById('stdPick').onchange = (ev) => {
          const pick = options[Number(ev.target.value)];
          if (!pick) return;
          for (const [k] of NUTRIENTS) form[`n_${k}`].value = pick[2][k];
          drawCheck(); drawPhotos();
          toast(`Filled with standard values for ${pick[0].toLowerCase()}`);
        };
      } else if (act.dataset.act === 'to-list') {
        await api('list.add', { product_id: p.id, qty: 1 }); toast('Added to list');
      } else if (act.dataset.act === 'delete') {
        if (!confirm(`Delete ${p.name}? It will also be removed from recipes.`)) return;
        await api('products.delete', { id: p.id }); closeSheet(); route();
      }
    } catch (er) { fail(er); }
  };

  function collect() {
    const prices = {};
    for (const s of S.stores) prices[s.id] = form[`price_${s.id}`].value;
    const nutrition = {};
    for (const [k] of NUTRIENTS) nutrition[k] = form[`n_${k}`].value;
    return {
      name: form.name.value, brand: form.brand.value, category: form.category.value, barcode: form.barcode.value,
      pack_size: form.pack_size.value, unit: form.unit.value, prices, nutrition,
      ingredients: form.ingredients.value, nutriscore: health.nutriscore, nova: health.nova, additives: health.additives,
    };
  }

  let shareLater = null;
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = collect();
      const { product } = await api('products.save', { id: p.id, ...data });
      if (pendingPhoto) await api('products.photo', { product_id: product.id, kind: 'label', mime: 'image/jpeg', data: pendingPhoto });
      shareLater = product && product.id > 0 && product.barcode ? product.id : null;
      const home = form.pantry.value === '' ? 0 : Number(form.pantry.value);
      if (home !== (p.pantry || 0)) await api('pantry.set', { product_id: product.id, amount: home });
      if (addToList) await api('list.add', { product_id: product.id, qty: 1 });
      closeSheet();
      toast(addToList ? 'Saved and added to list' : 'Saved');
      await loadProducts();
      route();
      if (shareLater) offAfterSave(shareLater);
    } catch (er) { fail(er); }
  };
}

/* ---------- giving back to Open Food Facts ---------- */
/** After a product with a barcode is saved: share it if the person said yes, or ask them once. */
function offAfterSave(pid) {
  if (!S.offReady || !navigator.onLine) return;
  if (S.offShare === '1') { api('off.queue', { product_id: pid }).then((r) => r.queued && offSync()).catch(() => {}); return; }
  if (S.offShare === '') offConsentSheet(pid);
}
function offSync() { setTimeout(() => api('off.sync').catch(() => {}), 500); }
function offConsentSheet(pid) {
  let answered = false;
  openSheet(`${sheetHead('Help other South Africans scan')}
    <p>Lots of South African products aren't in Open Food Facts yet, the free food database this app looks barcodes up in. Can the app add the products you save?</p>
    <ul class="stack tight small">
      <li>Only what's missing there is added: the product's name, brand, pack size, ingredients, nutrition per 100 g and label photos.</li>
      <li>It becomes public, under open licences, for anyone to use, including other apps.</li>
      <li>Your name, prices, lists and plans are never sent.</li>
    </ul>
    <button type="button" class="btn primary block" data-share="1">Yes, share products I add</button>
    <button type="button" class="btn block" data-share="0">No thanks</button>
    <p class="small muted">You can change this any time under Me.</p>`, () => { if (!answered) S.offShare = ''; });
  sheetBody.onclick = async (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    answered = true;
    try {
      const r = await api('off.consent', { share: b.dataset.share === '1', product_id: pid });
      S.offShare = r.off_share;
      closeSheet();
      if (r.queued) { toast('Thanks, it goes to Open Food Facts in the background'); offSync(); }
    } catch (er) { fail(er); }
  };
}

/* ================= HEALTH: product view, X-ray, alerts, swaps ================= */
/* What we know about common additives: [name, what it is, level, note].
   level 'red' = a regulator acts on it (EU warning label or ban); 'amber' = keep it occasional; null = nothing flagged.
   Anything else is only flagged when the person adds it to their own alerts. */
const SIX = 'EU packs must warn it "may have an adverse effect on activity and attention in children". Still allowed in South Africa.';
const NITRITE = "Cures processed meat. The WHO's cancer agency classes processed meat as a cause of bowel cancer, so keep it occasional.";
const SULPHITE = 'Can trigger asthma in people sensitive to sulphites.';
const ADDITIVES = {
  e100: ['Curcumin', 'yellow colouring'], e120: ['Cochineal (carmine)', 'red colouring, made from insects'],
  e150a: ['Caramel colour', 'brown colouring'], e150c: ['Caramel colour', 'brown colouring'], e150d: ['Caramel colour', 'brown colouring'],
  e160a: ['Carotenes', 'orange colouring'], e160c: ['Paprika extract', 'red colouring'], e162: ['Beetroot red', 'red colouring'],
  e102: ['Tartrazine', 'yellow colouring', 'red', SIX], e104: ['Quinoline yellow', 'yellow colouring', 'red', SIX],
  e110: ['Sunset yellow', 'orange colouring', 'red', SIX], e122: ['Carmoisine', 'red colouring', 'red', SIX],
  e124: ['Ponceau 4R', 'red colouring', 'red', SIX], e129: ['Allura red', 'red colouring', 'red', SIX],
  e171: ['Titanium dioxide', 'white colouring', 'red', 'Not allowed in food in the EU since 2022. Still allowed in South Africa.'],
  e200: ['Sorbic acid', 'preservative'], e202: ['Potassium sorbate', 'preservative'], e211: ['Sodium benzoate', 'preservative'],
  e220: ['Sulphur dioxide', 'preservative', null, SULPHITE], e221: ['Sodium sulphite', 'preservative', null, SULPHITE],
  e222: ['Sodium bisulphite', 'preservative', null, SULPHITE], e223: ['Sodium metabisulphite', 'preservative', null, SULPHITE],
  e224: ['Potassium metabisulphite', 'preservative', null, SULPHITE], e226: ['Calcium sulphite', 'preservative', null, SULPHITE],
  e227: ['Calcium bisulphite', 'preservative', null, SULPHITE], e228: ['Potassium bisulphite', 'preservative', null, SULPHITE],
  e249: ['Potassium nitrite', 'curing salt', 'amber', NITRITE], e250: ['Sodium nitrite', 'curing salt', 'amber', NITRITE],
  e251: ['Sodium nitrate', 'curing salt', 'amber', NITRITE], e252: ['Potassium nitrate', 'curing salt', 'amber', NITRITE],
  e260: ['Acetic acid', 'acidity regulator'], e270: ['Lactic acid', 'acidity regulator'], e281: ['Sodium propionate', 'preservative'],
  e282: ['Calcium propionate', 'preservative'], e290: ['Carbon dioxide', 'fizz'], e296: ['Malic acid', 'acidity regulator'],
  e300: ['Ascorbic acid (vitamin C)', 'antioxidant'], e301: ['Sodium ascorbate', 'antioxidant'], e306: ['Tocopherols (vitamin E)', 'antioxidant'],
  e316: ['Sodium erythorbate', 'antioxidant'], e322: ['Lecithins', 'emulsifier'], e330: ['Citric acid', 'acidity regulator'],
  e331: ['Sodium citrates', 'acidity regulator'], e332: ['Potassium citrates', 'acidity regulator'], e338: ['Phosphoric acid', 'acidity regulator'],
  e339: ['Sodium phosphates', 'stabiliser'], e341: ['Calcium phosphates', 'stabiliser'], e401: ['Sodium alginate', 'thickener'],
  e407: ['Carrageenan', 'thickener'], e410: ['Locust bean gum', 'thickener'], e412: ['Guar gum', 'thickener'], e414: ['Gum arabic', 'thickener'],
  e415: ['Xanthan gum', 'thickener'], e420: ['Sorbitol', 'sweetener'], e421: ['Mannitol', 'sweetener'], e440: ['Pectins', 'thickener'],
  e450: ['Diphosphates', 'stabiliser'], e451: ['Triphosphates', 'stabiliser'], e452: ['Polyphosphates', 'stabiliser'],
  e460: ['Cellulose', 'thickener'], e466: ['Carboxymethyl cellulose', 'thickener'], e471: ['Mono- and diglycerides', 'emulsifier'],
  e481: ['Sodium stearoyl lactylate', 'emulsifier'], e500: ['Sodium carbonates', 'raising agent'], e503: ['Ammonium carbonates', 'raising agent'],
  e508: ['Potassium chloride', 'salt replacer'], e551: ['Silicon dioxide', 'anti-caking agent'],
  e620: ['Glutamic acid', 'flavour enhancer'], e621: ['MSG (monosodium glutamate)', 'flavour enhancer'], e627: ['Disodium guanylate', 'flavour enhancer'],
  e631: ['Disodium inosinate', 'flavour enhancer'], e635: ['Disodium ribonucleotides', 'flavour enhancer'],
  e950: ['Acesulfame K', 'sweetener'], e951: ['Aspartame', 'sweetener', null, 'In 2023 the WHO\'s cancer agency called it "possibly carcinogenic"; the food safety experts kept the same daily limit.'],
  e952: ['Cyclamate', 'sweetener'], e954: ['Saccharin', 'sweetener'], e955: ['Sucralose', 'sweetener'], e960: ['Steviol glycosides (stevia)', 'sweetener'],
  e961: ['Neotame', 'sweetener'], e962: ['Aspartame-acesulfame salt', 'sweetener'], e965: ['Maltitol', 'sweetener'], e966: ['Lactitol', 'sweetener'],
  e967: ['Xylitol', 'sweetener'], e968: ['Erythritol', 'sweetener'],
  e1404: ['Modified starch', 'thickener'], e1412: ['Modified starch', 'thickener'], e1414: ['Modified starch', 'thickener'],
  e1420: ['Modified starch', 'thickener'], e1422: ['Modified starch', 'thickener'], e1442: ['Modified starch', 'thickener'],
};
const ALERT_GROUPS = {
  sweeteners: { name: 'Sweeteners', what: 'Aspartame, sucralose, acesulfame K, cyclamate, saccharin, stevia…',
    codes: ['e420', 'e421', 'e950', 'e951', 'e952', 'e954', 'e955', 'e960', 'e961', 'e962', 'e965', 'e966', 'e967', 'e968'],
    words: ['aspartame', 'sucralose', 'acesulfame', 'cyclamate', 'saccharin', 'sweetener'] },
  colours: { name: 'Colours with an EU warning', what: 'The six: E102, E104, E110, E122, E124, E129', codes: ['e102', 'e104', 'e110', 'e122', 'e124', 'e129'], words: ['tartrazine', 'allura red', 'sunset yellow'] },
  nitrites: { name: 'Nitrites and nitrates', what: 'Curing salts in processed meat (E249–E252)', codes: ['e249', 'e250', 'e251', 'e252'], words: ['nitrite', 'nitrate'] },
  sulphites: { name: 'Sulphites', what: 'Preservatives that can trigger asthma (E220–E228)', codes: ['e220', 'e221', 'e222', 'e223', 'e224', 'e226', 'e227', 'e228'], words: ['sulphite', 'sulfite', 'sulphur dioxide'] },
  enhancers: { name: 'Flavour enhancers (MSG)', what: 'MSG and friends (E620–E635)', codes: ['e620', 'e621', 'e627', 'e631', 'e635'], words: ['monosodium glutamate', 'msg'] },
};
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const hasNutrition = (p) => NUTRIENTS.some(([k]) => p[k] !== null && p[k] !== undefined && p[k] !== '');
const isCode = (c) => /^e\d{3,4}[a-z]?$/.test(c);
const ICON_BELL = '<svg class="ico-bell" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-label="You asked for this" role="img"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

/** Everything flagged in a product for this person, with their own alert choices applied. */
function analyseProduct(p) {
  const prefs = S.alerts || {};
  const text = (p.ingredients || '').toLowerCase();
  const codes = new Set((p.additives || []).map((c) => String(c).toLowerCase()));
  for (const m of text.matchAll(/\be\s?-?\s?(\d{3,4}[a-z]?)\b/gi)) codes.add(`e${m[1].toLowerCase()}`);
  const items = [...codes].sort().map((code) => {
    const [name, what, level = null, note = ''] = ADDITIVES[code] || [code.toUpperCase(), 'additive'];
    const groups = Object.keys(ALERT_GROUPS).filter((g) => ALERT_GROUPS[g].codes.includes(code));
    let mine = prefs[code] || null;
    if (!mine && groups.some((g) => prefs[`group:${g}`] === 'always')) mine = 'always';
    return { code, label: code.toUpperCase(), name, what, baseLevel: level, level: mine === 'never' ? null : level, mine, groups, note };
  });
  // words on the person's watchlist, and words that belong to a watched group, found in the ingredient list
  const seen = new Set(items.map((i) => i.code));
  for (const [code, mode] of Object.entries(prefs)) {
    if (mode !== 'always') continue;
    const words = code.startsWith('group:') ? ((ALERT_GROUPS[code.slice(6)] || {}).words || []) : (isCode(code) ? [] : [code]);
    const groupName = code.startsWith('group:') ? (ALERT_GROUPS[code.slice(6)] || {}).name : '';
    for (const w of words) {
      if (!text.includes(w) || seen.has(w)) continue;
      if (code.startsWith('group:') && items.some((i) => i.groups.includes(code.slice(6)))) continue;   // already shown by E-number
      seen.add(w);
      items.push({ code: w, label: w, name: capital(w), what: groupName || 'on your watchlist', baseLevel: null, level: null, mine: 'always', groups: [], note: '', word: true });
    }
  }
  const alerts = items.filter((i) => i.mine === 'always' || i.level === 'red');
  const known = !!(p.ingredients || codes.size || p.nutriscore || p.nova || hasNutrition(p));
  return { items, alerts, known };
}

/** One plain sentence for an alert, words first and the code after. */
function alertSentence(i) {
  const id = i.word ? '' : ` (${i.label})`;
  if (i.level === 'red' || i.level === 'amber') return `${i.name}${id}, a ${i.what}. ${i.note}`;
  return `${i.name}${id}${i.what && !i.word ? `, a ${i.what}` : ''}: you asked to hear about this.`;
}
const sevRank = (i) => (i.level === 'red' ? 0 : i.level === 'amber' ? 1 : i.mine === 'always' ? 2 : 3);
const levelClass = (i) => (i.level === 'red' ? 'lv-red' : i.level === 'amber' ? 'lv-amber' : i.mine === 'always' ? 'lv-mine' : 'lv-none');
const levelWord = (i) => (i.level === 'red' ? 'Regulator warning' : i.level === 'amber' ? 'Keep it occasional' : i.mine === 'never' ? "You don't flag this" : i.mine === 'always' ? 'Your alert' : 'Nothing flagged');

/** UK traffic-light bands per 100 g (or 100 ml for drinks). */
function trafficHtml(p) {
  if (!hasNutrition(p) || p.unit === 'each') return '';
  const drink = ['ml', 'l'].includes(p.unit);
  const salt = p.sodium_mg === null || p.sodium_mg === undefined ? null : (p.sodium_mg * 2.5) / 1000;
  const rows = [
    ['Fat', p.fat_g, drink ? [1.5, 8.75] : [3, 17.5]], ['Sat. fat', p.satfat_g, drink ? [0.75, 2.5] : [1.5, 5]],
    ['Sugar', p.sugar_g, drink ? [2.5, 11.25] : [5, 22.5]], ['Salt', salt, drink ? [0.3, 0.75] : [0.3, 1.5]],
  ];
  return `<div class="tl">${rows.map(([n, v, [lo, hi]]) => {
    if (v === null || v === undefined || v === '') return `<span class="tl-pill tl-unknown"><b>${n}</b> ?</span>`;
    const c = v > hi ? 'tl-high' : v <= lo ? 'tl-low' : 'tl-med';
    const word = v > hi ? 'High' : v <= lo ? 'Low' : 'Med';
    return `<span class="tl-pill ${c}"><b>${n}</b> ${fmtQty(round(v, 1))} g<span class="tl-word">${word}</span></span>`;
  }).join('')}</div>`;
}

const NS_CAT_LABEL = { general: '', cheese: 'scored as cheese', redmeat: 'scored as red meat', fats: 'scored as a fat, oil, nut or seed', beverage: 'scored as a drink', water: 'water' };
function nutriScoreHtml(p) {
  const ns = nsGrade(p);
  const est = ns && ns.estimated ? ns.est : (!ns ? estimateNutriScore(p) : null);
  const strip = ns
    ? `<div class="ns-strip ${ns.estimated ? 'est' : ''}">${'abcde'.split('').map((g) => `<span class="ns ns-${g} ${g === ns.grade ? 'on' : ''}">${g.toUpperCase()}</span>`).join('')}</div>`
    : `<div class="ns-strip unknown"><span>Not known yet</span><span class="small muted">${est && est.missing ? `Add ${est.missing.join(', ')} from the label to work it out` : 'Open Food Facts has no score for it'}</span></div>`;
  const why = ns && ns.estimated && est.parts.length
    ? `<p class="small muted">Why ${ns.grade.toUpperCase()}: ${est.parts.map(([l, v]) => `${l.toLowerCase()} ${v > 0 ? '+' : '−'}${Math.abs(v)}`).join(', ')}${est.proteinIgnored ? ' (protein doesn’t count when the bad points are this high)' : ''}.${NS_CAT_LABEL[est.category] ? ` ${NS_CAT_LABEL[est.category][0].toUpperCase()}${NS_CAT_LABEL[est.category].slice(1)}.` : ''}</p>`
    : '';
  const nova = p.nova
    ? `<div class="row between"><b class="small">Processing</b><span class="small nova-${p.nova} strong">NOVA ${p.nova} · ${NOVA[p.nova]}</span></div>
       <div class="nova-bar">${[1, 2, 3, 4].map((n) => `<span class="${n === p.nova ? `on nova-${p.nova}` : ''}"></span>`).join('')}</div>`
    : '<div class="row between"><b class="small">Processing</b><span class="small muted">Not known yet</span></div>';
  return `<section class="card stack tight">
    <div class="row between"><b>Nutri-Score</b><span class="small muted">${p.nutriscore ? 'Open Food Facts' : ns ? 'Estimated from the label' : ''}</span></div>
    ${strip}${why}${trafficHtml(p)}${nova}</section>`;
}

function nutritionTableHtml(p) {
  if (!hasNutrition(p)) return '';
  const per = p.unit === 'each' ? 'per item' : ['ml', 'l'].includes(p.unit) ? 'per 100 ml' : 'per 100 g';
  const v = (k, u) => (p[k] === null || p[k] === undefined || p[k] === '' ? '<span class="muted">?</span>' : `${fmtQty(round(Number(p[k]), 1))} ${u}`);
  const salt = p.sodium_mg === null || p.sodium_mg === undefined ? '<span class="muted">?</span>' : `${fmtQty(round((p.sodium_mg * 2.5) / 1000, 2))} g`;
  const known = (k) => p[k] !== null && p[k] !== undefined && p[k] !== '';
  const rows = NUTRIENTS.filter(([k, , , , optional]) => !optional || known(k)).map(([k, label, u, sub]) => [label, v(k, u), sub]);
  rows.push(['Salt (from sodium)', salt, false]);
  return `<section class="card stack tight"><div class="row between"><b>Nutrition ${per}</b><span class="small muted">${p.pack_size ? `pack: ${packLabel(p) || fmtQty(p.pack_size)}` : ''}</span></div>
    <div class="nt label-view">${rows.map(([l, x, sub]) => `<div class="${sub ? 'sub' : ''}"><span class="muted">${l}</span><b>${x}</b></div>`).join('')}</div></section>`;
}

/** The ingredient list with every flagged or known additive as a tappable chip. */
function xrayText(p, a, { tag = 'button' } = {}) {
  const open = (cls, code) => (tag === 'button' ? `<button type="button" class="xr ${cls}" data-code="${esc(code)}">` : `<span class="xr ${cls}">`);
  const byCode = Object.fromEntries(a.items.map((i) => [i.code, i]));
  let html = esc(p.ingredients || '');
  html = html.replace(/\b[Ee]\s?-?\s?(\d{3,4}[a-z]?)\b/g, (m, n) => {
    const i = byCode[`e${n.toLowerCase()}`];
    return i ? `${open(levelClass(i), i.code)}${esc(m)}${i.mine === 'always' ? ICON_BELL : ''}</${tag}>` : esc(m);
  });
  for (const i of a.items.filter((x) => x.word)) {
    html = html.replace(new RegExp(`\\b(${i.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'), `${open('lv-mine', i.code)}$1${ICON_BELL}</${tag}>`);
  }
  return html;
}

/** Same aisle, no alerts, ranked by cheapest protein (or healthiest). */
function swapsFor(p, mode = 'protein') {
  const cat = (p.category || '').trim().toLowerCase();
  if (!cat) return [];
  const nsRank = (x) => (gradeOf(x) ? gradeOf(x).charCodeAt(0) : 120) * 10 + (x.nova || 5);
  return S.products.filter((x) => x.id !== p.id && (x.category || '').trim().toLowerCase() === cat)
    .map((x) => { const pr = priceAt(x.prices, S.storeId); return { p: x, price: pr.price, pc: proteinCost(x, pr.price), a: analyseProduct(x) }; })
    .filter((c) => c.a.alerts.length === 0)
    .sort(mode === 'health' ? (a, b) => nsRank(a.p) - nsRank(b.p) : (a, b) => (a.pc ?? 1e9) - (b.pc ?? 1e9));
}
const packGrams = (p) => ({ g: 1, kg: 1000, ml: 1, l: 1000 }[p.unit] || null);
const packProtein = (p) => (p.protein_g > 0 ? (packGrams(p) ? (p.protein_g * p.pack_size * packGrams(p)) / 100 : p.protein_g * p.pack_size) : 0);
const packSalt = (p) => (p.sodium_mg === null || p.sodium_mg === undefined ? null : ((packGrams(p) ? (p.sodium_mg * p.pack_size * packGrams(p)) / 100 : p.sodium_mg * p.pack_size) * 2.5) / 1000);
function bestSwap(p) {
  const mine = proteinCost(p, priceAt(p.prices, S.storeId).price);
  const list = swapsFor(p);
  const better = (c) => c.pc !== null && (mine === null || c.pc < mine - 0.01);
  const healthier = (c) => (gradeOf(c.p) || 'z') < (gradeOf(p) || 'z');
  return list.find(better) || list.find(healthier) || null;
}
/** What the swap does for the same protein as one pack of p. */
function swapMaths(p, c) {
  const price = priceAt(p.prices, S.storeId).price;
  const P = packProtein(p);
  if (!P || c.pc === null || price === null) return null;
  const cost = (c.pc * P) / 10;
  const sp = packSalt(c.p); const cpP = packProtein(c.p);
  return { protein: P, cost, price, saving: price - cost, salt: packSalt(p), swapSalt: sp !== null && cpP ? (sp / cpP) * P : null };
}
function swapCardHtml(p, c, { link = true } = {}) {
  const m = swapMaths(p, c);
  return `<${link ? 'button type="button" data-act="swaps"' : 'div'} class="card stack tight swap-card">
    <div class="row between"><span class="small muted caps">Swap from your products</span>${link ? '<span class="small accent">Compare ›</span>' : ''}</div>
    <div class="row gap">${nsBadge(c.p)}
      <div class="grow"><b>${esc(c.p.name)}</b><div class="small muted">${[packLabel(c.p), c.price !== null ? money(c.price) : 'no price', 'no alerts'].filter(Boolean).join(' · ')}</div></div>
      ${c.pc !== null ? `<div class="right"><b class="accent">${money(c.pc)}</b><div class="small muted">per 10 g protein</div></div>` : ''}</div>
    ${m && m.saving > 0.5 ? `<div class="small">Same ${Math.round(m.protein)} g of protein as your ${esc(packLabel(p) || 'pack')}: <b class="accent">${money(m.cost)}</b> instead of ${money(m.price)}</div>` : ''}
  </${link ? 'button' : 'div'}>`;
}

/** The product screen: alerts, Nutri-Score, nutrition, ingredients, best swap. */
function productView(p, { from = 'products', item = null } = {}) {
  const a = analyseProduct(p);
  const pr = priceAt(p.prices, S.storeId);
  const pc = proteinCost(p, pr.price);
  const swap = bestSwap(p);
  const first = a.alerts[0];
  openSheet(`${sheetHead(p.name)}
    <p class="small muted">${[esc(p.brand || ''), packLabel(p), pr.price !== null ? `${money(pr.price)}${pr.here ? '' : ` at ${esc(storeName(pr.storeId))}`}` : 'no price yet', pc !== null ? `<span class="accent">${proteinLabel(pc)}</span>` : ''].filter(Boolean).join(' · ')}</p>
    ${first ? `<button type="button" class="alert-banner ${levelClass(first)}" data-act="xray"><span class="grow">${esc(alertSentence(first))}${a.alerts.length > 1 ? ` <b>+${a.alerts.length - 1} more</b>` : ''}</span><span aria-hidden="true">›</span></button>` : ''}
    ${a.known ? '' : `<section class="card stack tight unknown-card"><b>We don't know what's in this yet</b>
      <span class="small muted">No Nutri-Score, nutrition or ingredients. Not knowing isn't the same as clean: add the label once and it's there for both of you.</span>
      <button type="button" class="btn small" data-act="edit">📷 Add the label</button></section>`}
    ${a.known ? nutriScoreHtml(p) : ''}
    ${nutritionTableHtml(p)}
    ${p.ingredients || a.items.length ? `<button type="button" class="card stack tight xray-card" data-act="xray">
        <div class="row between"><b>Ingredients</b><span class="small accent">X-ray ›</span></div>
        <span class="xray-chips">${[...a.items].sort((x, y) => sevRank(x) - sevRank(y)).map((i) => `<span class="xr ${levelClass(i)}">${esc(i.word ? i.name : `${i.label} ${i.name.split(' (')[0]}`)}${i.mine === 'always' ? ICON_BELL : ''}</span>`).join('') || '<span class="small muted">No additives</span>'}</span>
        ${p.ingredients ? `<span class="small muted">${p.ingredients.split(',').length} ingredients · tap to read the whole list</span>` : ''}
      </button>` : (a.known ? '<p class="small muted">No ingredient list yet. Add it from the label to check additives.</p>' : '')}
    ${swap ? swapCardHtml(p, swap) : ''}
    ${item ? `<div class="grid2"><button class="btn primary" data-act="item-price">${pr.here && !pr.shared ? 'Change the price' : `Add the ${esc(storeName(S.storeId))} price`}</button><button class="btn" data-act="edit">Edit product</button></div>`
      : `<div class="grid2"><button class="btn primary" data-act="add">Add to list</button><button class="btn" data-act="edit">Edit</button></div>
        ${isFood(p) ? `<button class="btn block" data-act="have">${atHome(p) ? `At home: ${PANTRY_LABEL[pantryState(p)].toLowerCase()} · change` : 'I have this at home'}</button>` : ''}`}`);
  sheetBody.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-code]');
    if (!t) return;
    try {
      if (t.dataset.code) return additiveSheet(t.dataset.code, p, () => productView(p, { from, item }));
      switch (t.dataset.act) {
        case 'xray': return xraySheet(p, () => productView(p, { from, item }));
        case 'swaps': return swapsSheet(p, () => productView(p, { from, item }));
        case 'item-price': closeSheet(); if (await askItemPrice(item)) route(); return;
        case 'have': return homeSheet(p);
        case 'edit': closeSheet(); return productEditor(p);
        case 'add': await api('list.add', { product_id: p.id, qty: 1 }); closeSheet(); toast(`${p.name} added to the list`); return route();
        default:
      }
    } catch (er) { fail(er); }
  };
}

function xraySheet(p, back) {
  const a = analyseProduct(p);
  openSheet(`${sheetHead('Ingredient X-ray')}
    <p class="small muted">${esc(p.name)}</p>
    <div class="legend"><span><i class="lv-red"></i>Regulator warning</span><span><i class="lv-amber"></i>Keep it occasional</span><span>${ICON_BELL} Your alert</span><span><i class="lv-none"></i>Nothing flagged</span></div>
    ${p.ingredients ? `<p class="card xray-text">${xrayText(p, a)}</p><p class="small muted">Ingredients are listed biggest first. Tap a highlighted one.</p>` : '<p class="small muted">No ingredient list saved, only the additives from Open Food Facts.</p>'}
    ${a.items.length ? `<ul class="list card flush">${a.items.map((i) => `<li class="tap" data-code="${esc(i.code)}"><span class="xr ${levelClass(i)}">${esc(i.word ? i.name : i.label)}</span><div class="grow"><div class="name">${esc(i.word ? i.what : i.name)}</div><div class="sub">${esc(levelWord(i))}</div></div>${i.mine === 'always' ? ICON_BELL : ''}<span class="muted">›</span></li>`).join('')}</ul>` : '<p class="small muted">No additives found.</p>'}
    <button type="button" class="btn block" data-act="manage">Manage my ingredient alerts</button>
    ${back ? '<button type="button" class="btn block ghost" data-act="back">Back</button>' : ''}`);
  sheetBody.onclick = (e) => {
    const c = e.target.closest('[data-code]');
    if (c) return additiveSheet(c.dataset.code, p, () => xraySheet(p, back));
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'manage') return alertsSheet(() => xraySheet(p, back));
    if (t.dataset.act === 'back') return back();
  };
}

async function setAlert(code, mode) {
  S.alerts = (await api('alerts.set', { code, mode })).alerts || {};
  if (Array.isArray(S.alerts)) S.alerts = {};
}

function additiveSheet(code, p, back) {
  const draw = () => {
    const i = analyseProduct(p).items.find((x) => x.code === code) || (() => {
      const [name, what, level = null, note = ''] = ADDITIVES[code] || [code.toUpperCase(), isCode(code) ? 'additive' : 'on your watchlist'];
      return { code, label: code.toUpperCase(), name, what, level, baseLevel: level, mine: (S.alerts || {})[code] || null, groups: [], note, word: !isCode(code) };
    })();
    const mode = (S.alerts || {})[code] || (i.mine === 'always' ? 'always' : null);
    const viaGroup = !(S.alerts || {})[code] && i.mine === 'always' ? i.groups.map((g) => ALERT_GROUPS[g].name).join(', ') : '';
    openSheet(`${sheetHead(i.word ? i.name : `${i.label} · ${i.name}`)}
      <span class="lv-tag ${levelClass({ ...i, level: i.baseLevel })}">${esc(i.baseLevel === 'red' ? 'Regulator warning' : i.baseLevel === 'amber' ? 'Keep it occasional' : 'Nothing flagged by regulators')}</span>
      ${i.note ? `<p>${esc(i.note)}</p>` : `<p class="muted">${i.word ? 'A word on your own watchlist.' : 'Approved for use, and nothing here flags it. You can still choose to hear about it.'}</p>`}
      <div class="grid2 small"><div class="card tight"><span class="muted">What it is</span><b>${esc(capital(i.what))}</b></div>
        <div class="card tight"><span class="muted">Why it's flagged</span><b>${esc(i.baseLevel === 'red' ? (code === 'e171' ? 'Banned in the EU' : 'EU warning label') : i.baseLevel === 'amber' ? 'Processed meat' : 'Only if you ask')}</b></div></div>
      <b class="small">When it's in something I scan or add</b>
      <div class="seg" role="group" aria-label="Alerts for ${esc(i.label)}">
        <button type="button" data-mode="always" aria-pressed="${mode === 'always'}" class="${mode === 'always' ? 'on' : ''}">Always alert me</button>
        <button type="button" data-mode="never" aria-pressed="${mode === 'never'}" class="${mode === 'never' ? 'on' : ''}">Don't flag this</button>
      </div>
      <p class="small muted">${mode === 'always' ? `You'll get a pop-up whenever you scan or add something with ${esc(i.word ? i.name : i.label)}.${viaGroup ? ` (On because of: ${esc(viaGroup)}.)` : ''}`
        : mode === 'never' ? `${esc(i.word ? i.name : i.label)} won't be highlighted or alerted on any product.`
        : i.baseLevel === 'red' ? 'Regulator warnings alert you unless you choose “Don\'t flag this”.' : 'Shown in the X-ray, no pop-ups.'}</p>
      ${mode ? '<button type="button" class="btn small ghost" data-mode="">Back to normal</button>' : ''}
      <button type="button" class="btn block" data-act="manage">Manage all ingredient alerts</button>
      ${back ? '<button type="button" class="btn block ghost" data-act="back">Back</button>' : ''}`);
    sheetBody.onclick = async (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) {
        const want = m.dataset.mode || null;
        try { await setAlert(code, want === mode ? null : want); draw(); } catch (er) { fail(er); }
        return;
      }
      const t = e.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'manage') return alertsSheet(() => additiveSheet(code, p, back));
      if (t.dataset.act === 'back') return back();
    };
  };
  draw();
}

function alertsSheet(back) {
  const draw = () => {
    const prefs = S.alerts || {};
    const name = (c) => (c.startsWith('group:') ? (ALERT_GROUPS[c.slice(6)] || {}).name || c : isCode(c) ? `${c.toUpperCase()}${ADDITIVES[c] ? ` ${ADDITIVES[c][0]}` : ''}` : capital(c));
    const list = (mode) => Object.keys(prefs).filter((c) => prefs[c] === mode && !c.startsWith('group:'));
    openSheet(`${sheetHead('Ingredient alerts')}
      <p class="small muted">Yours only. Red flags follow real regulator action (EU warnings and bans). Everything else is only flagged if you add it here.</p>
      <form class="row" id="alAdd"><input name="code" class="grow" placeholder="E-number or word: E951, peanut, gluten" autocomplete="off" aria-label="Add an ingredient alert"><button class="btn">Add</button></form>
      <h3>Quick groups</h3>
      <div class="stack tight">${Object.entries(ALERT_GROUPS).map(([k, g]) => {
        const on = prefs[`group:${k}`] === 'always';
        return `<button type="button" class="toggle-row" data-group="${k}" aria-pressed="${on}"><span class="grow"><b>${esc(g.name)}</b><span class="small muted block">${esc(g.what)}</span></span><span class="switch ${on ? 'on' : ''}" aria-hidden="true"><i></i></span></button>`;
      }).join('')}</div>
      <h3>Always alert me</h3>
      <div class="chips wrap">${list('always').map((c) => `<span class="chip-x lv-mine">${esc(name(c))}<button type="button" data-rm="${esc(c)}" aria-label="Remove ${esc(name(c))}">✕</button></span>`).join('') || '<span class="small muted">Nothing yet. Tap an ingredient in the X-ray, or add one above.</span>'}</div>
      <h3>Don't flag</h3>
      <div class="chips wrap">${list('never').map((c) => `<span class="chip-x">${esc(name(c))}<button type="button" data-rm="${esc(c)}" aria-label="Remove ${esc(name(c))}">✕</button></span>`).join('') || '<span class="small muted">Nothing hidden.</span>'}</div>
      ${back ? '<button type="button" class="btn block ghost" data-act="back">Back</button>' : ''}`);
    sheetBody.onsubmit = async (e) => {
      e.preventDefault();
      const v = e.target.code.value.trim();
      if (!v) return;
      try { await setAlert(v, 'always'); draw(); toast(`You'll be alerted about ${v}`); } catch (er) { fail(er); }
    };
    sheetBody.onclick = async (e) => {
      const g = e.target.closest('[data-group]');
      const rm = e.target.closest('[data-rm]');
      try {
        if (g) { const k = `group:${g.dataset.group}`; await setAlert(k, prefs[k] === 'always' ? null : 'always'); return draw(); }
        if (rm) { await setAlert(rm.dataset.rm, null); return draw(); }
      } catch (er) { return fail(er); }
      const t = e.target.closest('[data-act]');
      if (t && t.dataset.act === 'back') back();
    };
  };
  draw();
}

function swapsSheet(p, back) {
  let mode = 'protein';
  const draw = () => {
    const list = swapsFor(p, mode);
    const pr = priceAt(p.prices, S.storeId);
    const pc = proteinCost(p, pr.price);
    const a = analyseProduct(p);
    const best = list[0];
    const m = best ? swapMaths(p, best) : null;
    const onList = (S.listItems || []).some((i) => i.product_id === p.id && !i.checked);
    openSheet(`${sheetHead(`Swaps for ${p.name}`)}
      <p class="small muted">From products you've scanned or bought, in the same aisle (${esc(p.category || 'none set')}), with no alerts.</p>
      <div class="chips" role="group" aria-label="Sort swaps">
        <button type="button" class="chip ${mode === 'protein' ? 'active' : ''}" data-sort="protein">Cheapest protein</button>
        <button type="button" class="chip ${mode === 'health' ? 'active' : ''}" data-sort="health">Healthiest</button>
      </div>
      <section class="card stack tight"><span class="small muted">Now</span>
        <div class="row gap">${nsBadge(p)}<div class="grow"><b>${esc(p.name)}</b><div class="small ${a.alerts.length ? 'bad-text' : 'muted'}">${a.alerts.length ? `${a.alerts.length} alert${a.alerts.length === 1 ? '' : 's'}` : 'no alerts'}${p.nova ? ` · NOVA ${p.nova}` : ''} · ${pr.price !== null ? money(pr.price) : 'no price'}</div></div>
        ${pc !== null ? `<div class="right"><b>${money(pc)}</b><div class="small muted">per 10 g protein</div></div>` : ''}</div></section>
      ${best ? `<section class="card stack tight best-swap"><div class="row between"><span class="small accent strong">BEST SWAP</span><span class="small muted">${best.price !== null ? money(best.price) : 'no price'}</span></div>
        <div class="row gap">${nsBadge(best.p)}<div class="grow"><b>${esc(best.p.name)}</b><div class="small muted">${[packLabel(best.p), 'no alerts', best.p.nova ? `NOVA ${best.p.nova}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${best.pc !== null ? `<div class="right"><b class="accent">${money(best.pc)}</b><div class="small muted">per 10 g protein</div></div>` : ''}</div>
        ${m ? `<div class="small stack tight"><div class="row between"><span class="muted">${Math.round(m.protein)} g protein (your ${esc(packLabel(p) || 'pack')})</span><span>${m.saving > 0 ? `<s class="muted">${money(m.price)}</s> ` : ''}<b class="accent">${money(m.cost)}</b></span></div>
          ${m.salt !== null && m.swapSalt !== null ? `<div class="row between"><span class="muted">Salt in that much</span><span><s class="muted">${fmtQty(round(m.salt, 1))} g</s> <b>${m.swapSalt < 1 ? 'under 1 g' : `${fmtQty(round(m.swapSalt, 1))} g`}</b></span></div>` : ''}</div>` : ''}
        <button type="button" class="btn primary block" data-swap="${best.p.id}">${onList ? 'Swap on my list' : 'Add to my list'}</button></section>`
        : `<p class="empty">${p.category ? 'No better option in this aisle yet. Scan a few alternatives next time you shop.' : 'Set an aisle on this product to see swaps.'}</p>`}
      ${list.length > 1 ? `<ul class="list card flush">${list.slice(1, 6).map((c) => `<li>${nsBadge(c.p) || '<span class="ns ns-unknown">?</span>'}<div class="grow"><div class="name">${esc(c.p.name)}</div><div class="sub">${c.price !== null ? money(c.price) : 'no price'}${c.pc !== null ? ` · ${proteinLabel(c.pc)}` : ''}</div></div><button type="button" class="icon-btn add-btn" data-swap="${c.p.id}" aria-label="Use ${esc(c.p.name)} instead">⇄</button></li>`).join('')}</ul>` : ''}
      ${back ? '<button type="button" class="btn block ghost" data-act="back">Back</button>' : ''}`);
    sheetBody.onclick = async (e) => {
      const s = e.target.closest('[data-sort]');
      if (s) { mode = s.dataset.sort; return draw(); }
      const sw = e.target.closest('[data-swap]');
      if (sw) {
        const to = S.products.find((x) => x.id === Number(sw.dataset.swap));
        try {
          if (onList) await api('list.swap', { from: p.id, to: to.id });
          else await api('list.add', { product_id: to.id, qty: 1 });
          closeSheet(); toast(onList ? `Swapped for ${to.name}` : `${to.name} added`); route();
        } catch (er) { fail(er); }
        return;
      }
      const t = e.target.closest('[data-act]');
      if (t && t.dataset.act === 'back') back();
    };
  };
  draw();
}

/** Scanning something with an alert in the shop: why, what's in it, and a swap. */
function scanAlertSheet(p) {
  const a = analyseProduct(p);
  const swap = bestSwap(p);
  const first = a.alerts[0];
  openSheet(`<div class="sheet-head"><div class="row gap"><span class="alert-icon ${levelClass(first)}" aria-hidden="true">!</span><h2>${a.alerts.length === 1 ? `Contains ${esc(first.word ? first.name : first.label)}` : `${a.alerts.length} things before you buy`}</h2></div><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="small muted">${esc(p.name)}${priceAt(p.prices, S.storeId).price !== null ? ` · ${money(priceAt(p.prices, S.storeId).price)}` : ''}</p>
    ${a.alerts.map((i) => `<div class="alert-banner static ${levelClass(i)}"><span class="grow">${esc(alertSentence(i))}${(S.alerts || {})[i.code] === 'always' ? '<span class="small muted block">You chose “Always alert me”. <button type="button" class="linklike" data-code="' + esc(i.code) + '">Change</button></span>' : ''}</span></div>`).join('')}
    <div class="row wrap gap">${nsBadge(p, 'Nutri-Score ')}${p.nova ? `<span class="lv-tag nova-${p.nova}">NOVA ${p.nova}</span>` : ''}<button type="button" class="linklike" data-act="details">Full details ›</button></div>
    ${nutritionTableHtml(p)}
    ${swap ? swapCardHtml(p, swap) : ''}
    <div class="grid2">${swap ? `<button class="btn primary" data-act="take" data-id="${swap.p.id}">Take the swap</button>` : ''}<button class="btn ${swap ? '' : 'primary'}" data-act="buy">Buy anyway</button></div>
    <button type="button" class="btn block ghost" data-act="mute">Don't alert me about ${esc(first.word ? first.name : first.label)} again</button>`);
  sheetBody.onclick = async (e) => {
    const c = e.target.closest('[data-code]');
    if (c) return additiveSheet(c.dataset.code, p, () => scanAlertSheet(p));
    const t = e.target.closest('[data-act]');
    if (!t) return;
    try {
      switch (t.dataset.act) {
        case 'details': return productView(p, { from: 'scan' });
        case 'swaps': return swapsSheet(p, () => scanAlertSheet(p));
        case 'take': return quickAddSheet(S.products.find((x) => x.id === Number(t.dataset.id)));
        case 'buy': return quickAddSheet(p);
        case 'mute': await setAlert(first.code, 'never'); toast(`No more alerts about ${first.word ? first.name : first.label}`); return quickAddSheet(p);
        default:
      }
    } catch (er) { fail(er); }
  };
}

/* ================= RECIPES ================= */
const fmtMins = (m) => {
  if (!m) return '';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const unitWord = (u) => (u === 'each' ? '×' : u);
const recipeSteps = (r) => (r.steps && r.steps.length ? r.steps
  : (r.instructions || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).map((body) => ({ body, timer_minutes: null })));

async function renderRecipes() {
  const [{ recipes }] = await Promise.all([api('recipes.list'), loadProducts()]);
  S.recipes = recipes;
  const card = (r) => {
      const time = (r.prep_minutes || 0) + (r.cook_minutes || 0);
      const steps = recipeSteps(r).length;
      return `<article class="card stack tap" data-id="${r.id}">
        <div class="row"><h2 class="grow">${esc(r.name)}</h2><span class="num strong">${money(r.cost_per_serving)}<span class="small muted"> /portion</span></span></div>
        <div class="small muted">${r.servings} portion${r.servings > 1 ? 's' : ''} · ${money(r.cost)} a batch${time ? ` · ${fmtMins(time)}` : ''}${steps ? ` · ${steps} step${steps > 1 ? 's' : ''}` : ''}
          ${r.mine && r.is_public ? '<span class="tag">shared</span>' : ''}${!r.mine && r.owner_name ? `<span class="tag">by ${esc(r.owner_name)}</span>` : ''}
          ${r.missing_prices ? `<span class="tag warn">${r.missing_prices} unpriced</span>` : ''}</div>
        ${nutriHtml(r.nutrition_per_serving, r.missing_nutrition, r.items.length)}
      </article>`;
  };
  const mine = recipes.filter((r) => r.mine);
  const home = recipes.filter((r) => !r.mine && r.household);
  const others = recipes.filter((r) => !r.mine && !r.household);
  view.innerHTML = `
    ${planSwitch('recipes')}
    <button class="btn primary block" data-act="new">＋ New recipe</button>
    ${mine.length ? mine.map(card).join('') : '<p class="empty">No recipes of your own yet. Add the meals you prep, or copy one below and make it yours.</p>'}
    ${home.length ? `<h2 class="section-h">From ${esc(S.household ? S.household.name : 'your household')}</h2><p class="small muted">Plan and cook from these. Only the person who added one can change it.</p>${home.map(card).join('')}` : ''}
    ${others.length ? `<h2 class="section-h">Shared by others</h2><p class="small muted">Cook, plan and shop from these. Copy one to change it.</p>${others.map(card).join('')}` : ''}`;
  view.onclick = (e) => {
    if (e.target.closest('[data-act=new]')) return recipeEditor({ id: null, name: '', servings: 4, instructions: '', prep_minutes: null, cook_minutes: null, items: [], steps: [] });
    const card = e.target.closest('[data-id]');
    if (card) recipeView(recipes.find((r) => r.id === Number(card.dataset.id)));
  };
}

function nutriHtml(n, missing, count) {
  if (!n || missing >= count) return '';
  const v = (x, unit, d = 1) => (x === null || x === undefined ? '—' : `${round(x, d)}${unit}`);
  return `<div class="nutri">
    <div><b>${v(n.energy_kj, '', 0)}</b><span>kJ</span></div>
    <div><b>${v(n.protein_g, 'g')}</b><span>protein</span></div>
    <div><b>${v(n.carbs_g, 'g')}</b><span>carbs</span></div>
    <div><b>${v(n.fat_g, 'g')}</b><span>fat</span></div>
  </div>${missing ? `<div class="small warn-text">${missing} ingredient${missing > 1 ? 's' : ''} without nutrition info</div>` : ''}`;
}

/** Scale a recipe to a number of portions: amounts, cost of what's used, and whole packs to buy. */
function scaleRecipe(r, portions) {
  const f = portions / r.servings;
  let used = 0; let toBuy = 0; let missing = 0;
  const items = r.items.map((it) => {
    const p = S.products.find((x) => x.id === it.product_id);
    const price = p ? priceAt(p.prices, null).price : null;
    const amount = it.amount * f;
    const qty = it.qty === null || it.qty === undefined ? null : it.qty * f;
    const packs = Math.max(1, Math.ceil(amount / it.pack_size - 1e-6));
    const cost = price === null ? null : (amount / it.pack_size) * price;
    if (price === null) missing++;
    else { used += cost; toBuy += packs * price; }
    return { ...it, amount, qty, packs, cost };
  });
  return { items, used, toBuy, missing, perPortion: used / portions };
}

function recipeView(r, portions = r.servings) {
  let n = portions;
  let first = true;
  const steps = recipeSteps(r);
  const draw = () => {
    const keepY = first ? 0 : sheetBody.scrollTop;
    first = false;
    const sc = scaleRecipe(r, n);
    const time = [r.prep_minutes ? `Prep ${fmtMins(r.prep_minutes)}` : '', r.cook_minutes ? `Cook ${fmtMins(r.cook_minutes)}` : ''].filter(Boolean).join(' · ');
    openSheet(`${sheetHead(r.name)}
      ${time ? `<p class="small muted">${time}</p>` : ''}
      <section class="card stack">
        <div class="row between">
          <span>Recipe makes <b>${r.servings} portion${r.servings === 1 ? '' : 's'}</b></span>
          ${r.mine ? '<button type="button" class="btn small" data-act="makes">Change</button>' : ''}
        </div>
        <div class="row between">
          <span class="strong">Cooking this time</span>
          <div class="qty big"><button type="button" data-act="minus" aria-label="Fewer portions">−</button><span>${fmtQty(n)}</span><button type="button" data-act="plus" aria-label="More portions">+</button></div>
        </div>
        <div class="grid3 right">
          <div><div class="small muted">Per portion</div><b class="num">${money(sc.perPortion)}</b></div>
          <div><div class="small muted">Batch uses</div><b class="num">${money(sc.used)}</b></div>
          <div><div class="small muted">Packs cost</div><b class="num">${money(sc.toBuy)}</b></div>
        </div>
        ${(() => {
          const prot = r.nutrition_per_serving ? r.nutrition_per_serving.protein_g : 0;
          return prot > 0 && sc.perPortion > 0 ? `<p class="small"><b>${Math.round(prot)} g protein</b> per portion · <span class="protein-cost">${proteinLabel((sc.perPortion / prot) * 10)}</span>${r.missing_nutrition ? ' <span class="muted">(some ingredients have no nutrition)</span>' : ''}</p>` : '';
        })()}
        ${sc.missing ? `<p class="small warn-text">${sc.missing} ingredient${sc.missing > 1 ? 's have' : ' has'} no price yet, so costs are low.</p>` : ''}
        ${n !== r.servings ? `<p class="small muted">Amounts scaled from the recipe's ${r.servings} portions.</p>` : ''}
      </section>

      <button class="btn primary block" data-act="cook">Start cook mode</button>

      <section class="stack">
        <h3>Ingredients</h3>
        <ul class="ing-list">${sc.items.map((it) => `<li>
          <span class="amt num">${ingLabel(it)}</span>
          <span class="grow">${esc(it.name)}${it.note ? `<span class="muted">, ${esc(it.note)}</span>` : ''}<span class="small muted block">buy ${it.packs} × ${fmtQty(it.pack_size)} ${unitWord(it.unit)}</span></span>
          <span class="num small">${money(it.cost)}</span></li>`).join('') || '<li class="muted">No ingredients yet.</li>'}</ul>
      </section>

      ${steps.length ? `<section class="stack"><h3>Method</h3><ol class="steps">${steps.map((s) => `<li>${esc(s.body)}${s.timer_minutes ? ` <span class="tag">${fmtMins(s.timer_minutes)}</span>` : ''}</li>`).join('')}</ol></section>` : ''}
      ${r.steps && r.steps.length && r.instructions ? `<section class="stack"><h3>Notes</h3><p class="small muted pre">${esc(r.instructions)}</p></section>` : ''}

      ${r.nutrition_per_serving && r.missing_nutrition < r.items.length ? `<section class="stack"><h3>Per portion</h3>${nutriHtml(r.nutrition_per_serving, r.missing_nutrition, r.items.length)}</section>` : ''}

      <section class="card stack">
        <h3>Portion weights</h3>
        <p class="small muted">Weigh the whole cooked batch, then split it evenly.</p>
        <div class="row"><label class="grow">Cooked batch (g) <input id="batchG" type="number" inputmode="numeric" min="0" step="1"></label>
          <div class="right"><div class="small muted">Each container</div><b id="perG" class="num">—</b></div></div>
      </section>

      <div class="grid2">
        <button class="btn" data-act="fridge">Cooked it → fridge</button>
        <button class="btn" data-act="list">Add to list</button>
        <button class="btn" data-act="plan">Add to plan</button>
        ${r.mine ? '<button class="btn" data-act="edit">Edit recipe</button>' : '<button class="btn" data-act="copy">Copy to my recipes</button>'}
      </div>
      ${r.mine ? `<div class="toggle-row static"><span class="grow"><b>Share with everyone</b><span class="small muted block">${r.is_public ? 'Everyone on the app can see, cook and plan this. Only you can change it.' : 'Only you can see this recipe.'}</span></span>
          <button type="button" class="switch ${r.is_public ? 'on' : ''}" data-act="share" aria-pressed="${r.is_public}" aria-label="Share ${esc(r.name)} with everyone"><i></i></button></div>
        <button class="btn block danger" data-act="delete">Delete recipe</button>`
        : `<p class="small muted">Shared by ${esc(r.owner_name || 'a former member')}. Only they can change it.</p>`}`);
    sheetBody.scrollTop = keepY;
    const batch = document.getElementById('batchG');
    const per = () => {
      const g = Number(batch.value);
      document.getElementById('perG').textContent = g > 0 ? `${Math.round(g / n)} g` : '—';
    };
    batch.oninput = per;
    sheetBody.onclick = async (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      try {
        switch (t.dataset.act) {
          case 'makes': {
            const v = await askNumber(`How many portions does ${r.name} make?`, r.servings,
              { hint: 'The ingredients stay the same; the batch is just split into this many containers. Costs and nutrition per portion update.', step: '1' });
            if (v === null || v === undefined || v === '' || !(Number(v) >= 1)) return recipeView(r, n);
            await api('recipes.servings', { id: r.id, servings: Math.round(Number(v)) });
            const fresh = (await api('recipes.list')).recipes.find((x) => x.id === r.id) || r;
            toast(`${r.name} now makes ${fresh.servings} portions`);
            return recipeView(fresh, fresh.servings);
          }
          case 'share': {
            const upd = (await api('recipes.share', { id: r.id, public: !r.is_public })).recipe;
            toast(upd.is_public ? 'Shared with everyone' : 'Only you can see it now');
            return recipeView(upd, n);
          }
          case 'copy': {
            const c = (await api('recipes.copy', { id: r.id })).recipe;
            toast('Copied to your recipes. Change it as you like');
            return recipeView(c, c.servings);
          }
          case 'delete':
            if (!confirm(`Delete ${r.name}? It also comes off your meal plan.`)) return;
            await api('recipes.delete', { id: r.id });
            closeSheet(); toast(`Deleted ${r.name}`); route();
            return;
          case 'minus': n = Math.max(1, n - 1); return draw();
          case 'plus': n = Math.min(100, n + 1); return draw();
          case 'cook': closeSheet(); return cookMode(r, n);
          case 'edit': closeSheet(); return recipeEditor(r);
          case 'plan': closeSheet(); return planAddSheet(iso(new Date()), r.id);
          case 'list': {
            const res = await api('recipes.to_list', { id: r.id, portions: n });
            toast(`${res.added} item${res.added === 1 ? '' : 's'} added to the list`);
            return;
          }
          case 'fridge': {
            const g = Number(batch.value);
            await api('fridge.cook', { recipe_id: r.id, portions: n, grams_per_portion: g > 0 ? Math.round(g / n) : null });
            closeSheet();
            toast(`${fmtQty(n)} portions in the fridge`);
            return;
          }
          default:
        }
      } catch (er) { fail(er); }
    };
  };
  draw();
}

/* ---------- cook mode ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported or denied: the screen may dim, nothing else breaks */ }
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* no audio */ }
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
}

function cookMode(r, portions, opts = {}) {
  const steps = recipeSteps(r);
  const sc = scaleRecipe(r, portions);
  const first = opts.skipGather ? 0 : -1;
  let idx = first; // -1 = gather ingredients, steps.length = done
  const timers = {}; // step index -> { end, left, running }
  const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  let tick = null;

  const draw = () => {
    let body;
    if (idx < 0) {
      body = `<p class="muted">Get everything out first. Amounts are for ${fmtQty(portions)} portions.</p>
        <ul class="ing-list check">${sc.items.map((it) => `<li><label class="row grow"><input type="checkbox"><span class="amt num">${ingLabel(it)}</span><span class="grow">${esc(it.name)}${it.note ? `<span class="muted">, ${esc(it.note)}</span>` : ''}</span></label></li>`).join('')}</ul>
        <button class="btn primary block" data-act="next">${steps.length ? 'Start cooking' : 'Done cooking'}</button>`;
    } else if (idx < steps.length) {
      const s = steps[idx];
      const t = timers[idx];
      const timerHtml = s.timer_minutes ? `<div class="timer">
          <span class="num clock" id="clock">${fmtClock(t ? (t.running ? t.end - Date.now() : t.left) : s.timer_minutes * 60000)}</span>
          <button class="btn ${t && t.running ? '' : 'primary'}" data-act="timer">${t && t.running ? 'Pause' : t ? 'Resume' : `Start ${fmtMins(s.timer_minutes)} timer`}</button>
          ${t ? '<button class="btn small" data-act="reset">Reset</button>' : ''}</div>` : '';
      body = `<div class="small muted">Step ${idx + 1} of ${steps.length}</div>
        <p class="cook-step">${esc(s.body)}</p>
        ${timerHtml}
        <div class="grid2"><button class="btn" data-act="back">Back</button><button class="btn primary" data-act="next">${idx === steps.length - 1 ? 'Finish' : 'Next step'}</button></div>`;
    } else {
      body = `<h2>Done. Into containers it goes.</h2>
        <label>Cooked batch weight (g), optional <input id="doneG" type="number" inputmode="numeric" min="0"></label>
        <p class="small muted" id="doneEach">Split into ${fmtQty(portions)} containers.</p>
        <button class="btn primary block" data-act="fridge">Put ${fmtQty(portions)} portions in the fridge</button>
        <button class="btn block" data-act="back">Back to the steps</button>`;
    }
    const running = Object.entries(timers).filter(([i, t]) => t.running && Number(i) !== idx);
    openSheet(`${sheetHead(r.name)}
      ${opts.label ? `<div class="small muted">${esc(opts.label)}</div>` : ''}
      ${running.length ? `<div class="timers">${running.map(([i, t]) => `<button class="pill" data-goto="${i}">Step ${Number(i) + 1} · <span class="num" data-clock="${i}">${fmtClock(t.end - Date.now())}</span></button>`).join('')}</div>` : ''}
      ${body}`, () => { clearInterval(tick); keepAwake(false); });
    sheetBody.classList.add('full');
    const doneG = document.getElementById('doneG');
    if (doneG) doneG.oninput = () => { const g = Number(doneG.value); document.getElementById('doneEach').textContent = g > 0 ? `${Math.round(g / portions)} g in each of ${fmtQty(portions)} containers.` : `Split into ${fmtQty(portions)} containers.`; };
    sheetBody.onclick = async (e) => {
      const go = e.target.closest('[data-goto]');
      if (go) { idx = Number(go.dataset.goto); return draw(); }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const t = timers[idx];
      switch (a.dataset.act) {
        case 'next': idx = Math.min(steps.length, idx + 1); return draw();
        case 'back': idx = Math.max(first, idx - 1); return draw();
        case 'timer':
          if (!t) timers[idx] = { end: Date.now() + steps[idx].timer_minutes * 60000, running: true };
          else if (t.running) { t.left = t.end - Date.now(); t.running = false; }
          else { t.end = Date.now() + t.left; t.running = true; }
          return draw();
        case 'reset': delete timers[idx]; return draw();
        case 'fridge': {
          const g = Number((document.getElementById('doneG') || {}).value);
          try {
            await api('fridge.cook', { recipe_id: r.id, portions, grams_per_portion: g > 0 ? Math.round(g / portions) : null });
            closeSheet();
            toast(`${fmtQty(portions)} portions in the fridge`);
            if (opts.onDone) opts.onDone();
            else refreshHome();
          } catch (er) { fail(er); }
          return;
        }
        default:
      }
    };
  };

  keepAwake(true);
  draw();
  tick = setInterval(() => {
    for (const [i, t] of Object.entries(timers)) {
      if (!t.running) continue;
      const left = t.end - Date.now();
      if (left <= 0) {
        t.running = false; t.left = 0;
        beep();
        toast(`Timer done: step ${Number(i) + 1}`);
        if (!sheet.hidden) draw();
        continue;
      }
      const el = Number(i) === idx ? document.getElementById('clock') : sheetBody.querySelector(`[data-clock="${i}"]`);
      if (el) el.textContent = fmtClock(left);
    }
  }, 500);
}

/* ---------- recipe editor ---------- */
function recipeEditor(r) {
  // each row: the product, and the amount as typed in a unit that suits it
  let rows = r.items.map((i) => ({ product_id: i.product_id, name: i.name, qty: i.qty ?? i.amount, qty_unit: i.qty_unit || i.unit, note: i.note || '' }));
  let steps = (r.steps && r.steps.length ? r.steps : recipeSteps(r)).map((s) => ({ body: s.body, timer_minutes: s.timer_minutes }));
  const notes = r.steps && r.steps.length ? (r.instructions || '') : '';
  const prodOf = (id) => S.products.find((x) => x.id === Number(id));

  openSheet(`${sheetHead(r.id ? 'Edit recipe' : 'New recipe')}
    <form class="stack" id="rForm">
      <label>Name <input name="name" required value="${esc(r.name)}" placeholder="Chicken & rice prep"></label>
      <div class="grid3">
        <label>Portions <input name="servings" type="number" inputmode="numeric" min="1" step="1" value="${r.servings}"></label>
        <label>Prep (min) <input name="prep_minutes" type="number" inputmode="numeric" min="0" value="${r.prep_minutes ?? ''}"></label>
        <label>Cook (min) <input name="cook_minutes" type="number" inputmode="numeric" min="0" value="${r.cook_minutes ?? ''}"></label>
      </div>
      <fieldset><legend>Ingredients</legend>
        <div id="ingRows" class="stack"></div>
        <div class="field ing-search">
          <input id="ingFind" placeholder="Add an ingredient: type to search" autocomplete="off" enterkeyhint="search" aria-label="Search for an ingredient">
          <div id="ingSuggest" class="suggest" hidden></div>
        </div>
      </fieldset>
      <div class="card stack" id="rSummary"></div>
      <fieldset><legend>Method</legend>
        <div id="stepRows" class="stack"></div>
        <button type="button" class="btn small" data-act="add-step">＋ Step</button>
      </fieldset>
      <label>Notes <textarea name="instructions" placeholder="Storage, swaps, what worked…">${esc(notes)}</textarea></label>
      <button class="btn primary block">Save recipe</button>
      ${r.id ? '<button type="button" class="btn danger block" data-act="delete">Delete recipe</button>' : ''}
    </form>`);
  const form = document.getElementById('rForm');
  const box = document.getElementById('ingRows');
  const stepBox = document.getElementById('stepRows');

  const drawRows = () => {
    box.innerHTML = rows.map((row, i) => {
      const p = prodOf(row.product_id);
      const units = p ? ingUnitsFor(p) : [row.qty_unit];
      if (p && !units.includes(row.qty_unit)) units.unshift(row.qty_unit);
      return `<div class="ing" data-i="${i}">
        <div class="ing-name"><b>${esc(p ? p.name : row.name || 'Unknown product')}</b>${p ? `<span class="small muted"> ${esc(p.brand || '')} ${packLabel(p)}</span>` : ''}</div>
        <div class="ing-row">
          <input data-f="qty" type="number" inputmode="decimal" step="0.001" min="0" value="${row.qty ?? ''}" placeholder="how much" aria-label="Amount of ${esc(p ? p.name : '')}">
          <select data-f="qty_unit" aria-label="Unit">${units.map((u) => `<option value="${u}" ${u === row.qty_unit ? 'selected' : ''}>${ING_LABEL[u] || u}</option>`).join('')}</select>
          <input data-f="note" value="${esc(row.note)}" placeholder="note, e.g. grated" aria-label="Note">
          <button type="button" class="icon-btn" data-act="rm-ing" aria-label="Remove ingredient">✕</button>
        </div>
      </div>`;
    }).join('') || '<p class="muted small">No ingredients yet. Search above: cheese, chicken, rice…</p>';
    summary();
  };
  const drawSteps = () => {
    stepBox.innerHTML = steps.map((s, i) => `<div class="step-row" data-s="${i}">
        <span class="step-num">${i + 1}</span>
        <textarea data-f="body" rows="2" placeholder="What to do">${esc(s.body)}</textarea>
        <div class="step-tools">
          <input data-f="timer_minutes" type="number" inputmode="numeric" min="0" value="${s.timer_minutes ?? ''}" placeholder="—" aria-label="Timer minutes">
          <span class="small muted grow">min timer</span>
          <button type="button" class="icon-btn" data-act="up" aria-label="Move step up" ${i ? '' : 'disabled'}>↑</button>
          <button type="button" class="icon-btn" data-act="rm-step" aria-label="Remove step">✕</button>
        </div>
      </div>`).join('') || '<p class="muted small">No steps yet. Add one per action: "Bake chicken 25 min at 200 °C".</p>';
  };
  const summary = () => {
    const servings = Math.max(1, Number(form.servings.value) || 1);
    const tmp = { servings, items: rows.filter((x) => prodOf(x.product_id) && x.qty > 0).map((x) => {
      const p = prodOf(x.product_id);
      return { product_id: p.id, name: p.name, unit: p.unit, pack_size: p.pack_size, amount: ingToProductUnit(Number(x.qty), x.qty_unit, p) || 0 };
    }) };
    const sc = scaleRecipe(tmp, servings);
    document.getElementById('rSummary').innerHTML = `
      <div class="row between"><b>Batch cost</b><b class="num">${money(sc.used)}</b></div>
      <div class="row between small muted"><span>Per portion</span><span class="num">${money(sc.perPortion)}</span></div>
      ${sc.missing ? `<div class="small warn-text">${sc.missing} ingredient${sc.missing > 1 ? 's' : ''} without a price</div>` : ''}`;
  };
  drawRows();
  drawSteps();

  sheetBody.oninput = (e) => {
    const ing = e.target.closest('.ing');
    const st = e.target.closest('.step-row');
    if (ing) {
      const f = e.target.dataset.f;
      rows[Number(ing.dataset.i)][f] = f === 'note' || f === 'qty_unit' ? e.target.value : (e.target.value === '' ? null : Number(e.target.value));
      summary();
    } else if (st) {
      const f = e.target.dataset.f;
      steps[Number(st.dataset.s)][f] = f === 'body' ? e.target.value : (e.target.value === '' ? null : Number(e.target.value));
    } else summary();
  };
  sheetBody.onchange = (e) => { if (e.target.dataset.f === 'qty_unit') sheetBody.oninput(e); };

  // ----- ingredient search: your products first, then the whole catalogue, then "add it as new" -----
  const find = document.getElementById('ingFind');
  const sug = document.getElementById('ingSuggest');
  sug.onpointerdown = (e) => e.preventDefault();   // keep the keyboard up mid-tap (see the shopping list)
  sug.onmousedown = (e) => e.preventDefault();
  let seq = 0;
  const addRow = (p) => {
    if (!prodOf(p.id)) S.products.push(p);
    rows.push({ product_id: p.id, name: p.name, qty: null, qty_unit: ingUnitsFor(p)[0], note: '' });
    find.value = ''; sug.hidden = true;
    drawRows();
    const last = box.querySelector('.ing:last-child [data-f=qty]');
    if (last) last.focus();
  };
  const rank = (p, q) => {
    const n = `${p.name} ${p.brand || ''}`.toLowerCase();
    return (n.startsWith(q) ? 0 : n.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2) - (p.bought_count ? 0.5 : 0);
  };
  const show = (list, q) => {
    sug.innerHTML = list.slice(0, 8).map((p) => `<button type="button" data-pick="${p.id}"><span>${esc(p.name)} <span class="muted small">${esc(p.brand || '')} ${packLabel(p)}</span></span></button>`).join('')
      + `<button type="button" data-newprod="1"><span>＋ New product “${esc(q)}”</span></button>`;
    sug.hidden = false;
  };
  find.oninput = () => {
    const q = find.value.trim().toLowerCase();
    if (q.length < 2) { sug.hidden = true; return; }
    const words = q.split(/\s+/);
    const local = S.products.filter((p) => { const n = `${p.name} ${p.brand || ''}`.toLowerCase(); return words.every((w) => n.includes(w)); })
      .sort((a, b) => rank(a, q) - rank(b, q) || a.name.localeCompare(b.name));
    show(local, find.value.trim());
    const mine = ++seq;
    clearTimeout(find.t);
    find.t = setTimeout(async () => {
      try {
        const { products } = await api('products.search', { q });
        if (mine !== seq) return;
        const seen = new Set(local.map((p) => p.id));
        show([...local, ...products.filter((p) => !seen.has(p.id))], find.value.trim());
      } catch { /* offline: local results are enough */ }
    }, 300);
  };
  find.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = sug.querySelector('button'); if (b) b.click(); } };
  sug.onclick = async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const id = Number(pick.dataset.pick);
      let p = prodOf(id);
      if (!p) { try { p = (await api('products.search', { q: find.value.trim() })).products.find((x) => x.id === id); } catch { /* ignore */ } }
      if (p) addRow(p);
      return;
    }
    if (e.target.closest('[data-newprod]')) {
      const name = find.value.trim();
      sug.innerHTML = `<div class="stack new-ing" id="newIng">
        <b>New product: ${esc(name)}</b>
        <span class="small muted">How do you buy it?</span>
        <div class="row"><input name="size" type="number" inputmode="decimal" step="0.001" min="0" placeholder="1" aria-label="Pack size" class="grow">
          <select name="unit" aria-label="Unit">${UNITS.map((u) => `<option value="${u}" ${u === 'kg' ? 'selected' : ''}>${u === 'each' ? 'items' : u}</option>`).join('')}</select></div>
        <button type="button" class="btn primary" data-mkprod="1">Add ${esc(name)}</button>
        <span class="small muted">Add its price and nutrition later under Kitchen.</span>
      </div>`;
      sug.querySelector('[name=size]').focus();
      return;
    }
    if (e.target.closest('[data-mkprod]')) {
      const name = find.value.trim();
      const wrap = sug.querySelector('#newIng');
      try {
        const { product } = await api('products.save', { name, pack_size: wrap.querySelector('[name=size]').value || 1, unit: wrap.querySelector('[name=unit]').value });
        addRow(product);
      } catch (er) { fail(er); }
    }
  };
  find.onblur = () => setTimeout(() => { if (!sug.contains(document.activeElement)) sug.hidden = true; }, 250);
  sheetBody.onclick = async (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const si = act.closest('.step-row') ? Number(act.closest('.step-row').dataset.s) : null;
    switch (act.dataset.act) {
      case 'rm-ing': rows.splice(Number(act.closest('.ing').dataset.i), 1); return drawRows();
      case 'add-step': steps.push({ body: '', timer_minutes: null }); drawSteps(); stepBox.querySelector('.step-row:last-child textarea').focus(); return;
      case 'rm-step': steps.splice(si, 1); return drawSteps();
      case 'up': if (si > 0) { [steps[si - 1], steps[si]] = [steps[si], steps[si - 1]]; drawSteps(); } return;
      case 'delete':
        if (!confirm(`Delete ${r.name}? It also comes off the meal plan.`)) return;
        try { await api('recipes.delete', { id: r.id }); closeSheet(); route(); } catch (er) { fail(er); }
        return;
      default:
    }
  };
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { recipe } = await api('recipes.save', {
        id: r.id, name: form.name.value, servings: form.servings.value,
        prep_minutes: form.prep_minutes.value, cook_minutes: form.cook_minutes.value,
        instructions: form.instructions.value,
        items: rows.filter((x) => x.product_id && x.qty > 0).map((x) => ({ product_id: x.product_id, qty: x.qty, qty_unit: x.qty_unit, note: x.note })),
        steps: steps.filter((s) => s.body && s.body.trim()),
      });
      closeSheet();
      toast('Recipe saved');
      if (location.hash === '#recipes') await route();
      recipeView(recipe);
    } catch (er) { fail(er); }
  };
}

/* ================= MEAL PLAN ================= */
function sinceLabel(d) {
  if (!d) return 'lately';
  const days = Math.floor((Date.now() - new Date(String(d).replace(' ', 'T')).getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/* ----- reading a label on the phone (Tesseract, free, nothing leaves the phone) ----- */
let ocrWorker = null;
function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Could not load the label reader')); document.head.appendChild(s); });
}
/** Start the reader once; the first time it downloads about 8 MB, then the phone keeps it. */
async function ocrWorkerGet(progress) {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) await loadScript('assets/ocr/tesseract.min.js');
  const abs = (p) => new URL(p, location.href).href;
  ocrWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: abs('assets/ocr/worker.min.js'), corePath: abs('assets/ocr/core'), langPath: abs('assets/ocr/lang'),
    gzip: false, workerBlobURL: false,
    logger: (m) => progress && progress(m),
  });
  return ocrWorker;
}
/** A photo (or part of it), upright, grey with stretched contrast: what Tesseract reads best.
 *  crop is in the photo's own pixels; width is the size to read it at. */
async function ocrPrepare(file, { crop = null, width = 2000 } = {}) {
  const bmp = file instanceof ImageBitmap ? file : await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const [x0, y0, cw, ch] = crop || [0, 0, bmp.width, bmp.height];
  const scale = crop ? Math.min(3, width / cw) : Math.min(1, width / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * scale); c.height = Math.round(ch * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, x0, y0, cw, ch, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height); const d = img.data;
  let lo = 255; let hi = 0;
  for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span)); d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(img, 0, 0);
  return { canvas: c, scale, bmp };
}
/** Read a photo. psm 6 reads it as one block (best for tables); psm 3 finds blocks itself (better for loose text). */
async function ocrRead(file, progress, psm = 6) {
  const w = await ocrWorkerGet(progress);
  await w.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1' });
  const { canvas } = await ocrPrepare(file);
  const { data } = await w.recognize(canvas);
  return data.text || '';
}
/** First pass over a label photo: read all of it (for the ingredients) and suggest where the nutrition table is.
 *  Returns { text, bmp, box } with box in the photo's own pixels [x, y, w, h], or null when no table was seen. */
async function ocrFindTable(file, progress) {
  const w = await ocrWorkerGet(progress);
  const whole = await ocrPrepare(file);
  await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
  const { data } = await w.recognize(whole.canvas, {}, { text: true, blocks: true });
  const lines = [];
  for (const b of data.blocks || []) for (const pa of b.paragraphs || []) for (const l of pa.lines || []) lines.push(l);
  const top = lines.findIndex((l) => /nutri|typical|average|per\s*100|\benerg/i.test(l.text));
  let box = null;
  if (top >= 0) {
    let bottom = top;
    for (let i = top; i < lines.length; i++) {
      if (/method|aoac|manufactured/i.test(lines[i].text)) break;
      bottom = i;
      if (/sodium|\bs\w{2}[il1]um\b|\bsalt\b/i.test(lines[i].text) && i > top + 3) break;
    }
    const part = lines.slice(top, bottom + 1);
    const b = part.reduce((m, l) => ({ x0: Math.min(m.x0, l.bbox.x0), y0: Math.min(m.y0, l.bbox.y0), x1: Math.max(m.x1, l.bbox.x1), y1: Math.max(m.y1, l.bbox.y1) }),
      { x0: Infinity, y0: Infinity, x1: 0, y1: 0 });
    if (part.length >= 3 && b.x1 > b.x0) {
      const k = 1 / whole.scale; const padY = (b.y1 - b.y0) * 0.04;
      const x0 = Math.max(0, b.x0 * k); const y0 = Math.max(0, (b.y0 - padY) * k);
      box = [x0, y0, Math.min(whole.bmp.width, b.x1 * k) - x0, Math.min(whole.bmp.height, (b.y1 + padY) * k) - y0];
    }
  }
  return { text: data.text || '', bmp: whole.bmp, box };
}
/** Second pass: just the chosen part of the photo, read as one block (how tables read best) at five sizes.
 *  The reader's mistakes change with the size, the right numbers don't: each row takes the value most readings agree on. */
const OCR_WIDTHS = [700, 900, 1160, 1400, 1740];
async function ocrReadPart(bmp, box, onStep) {
  const w = await ocrWorkerGet();
  await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  const texts = [];
  for (const [n, width] of OCR_WIDTHS.entries()) {
    if (onStep) onStep(n + 1, OCR_WIDTHS.length);
    const cut = await ocrPrepare(bmp, { crop: box, width });
    texts.push((await w.recognize(cut.canvas)).data.text || '');
  }
  return texts;
}
/** One label from several readings: a value needs at least two readings to agree, and more than any other value. */
function voteLabels(texts) {
  const parsed = texts.map(parseLabelText);
  const values = {}; const guessed = [];
  for (const [k] of NUTRIENTS) {
    const tally = new Map();
    for (const p of parsed) if (k in p.values) { const v = Math.round(p.values[k] * 100) / 100; tally.set(v, (tally.get(v) || 0) + 1); }
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
      values[k] = ranked[0][0];
      if (parsed.some((p) => p.guessed.includes(k) && Math.round(p.values[k] * 100) / 100 === ranked[0][0])) guessed.push(k);
    }
  }
  const servingFirst = parsed.filter((p) => p.servingFirst).length > parsed.length / 2;
  return { values, servingFirst, found: Object.keys(values).length, guessed, texts };
}

/** Show the photo with a box to drag around the nutrition table. Resolves with the box in photo pixels, or null. */
function cropPicker(host, bmp, start) {
  return new Promise((done) => {
    const W = bmp.width; const H = bmp.height;
    let [x, y, w, h] = start || [W * 0.1, H * 0.25, W * 0.8, H * 0.5];
    const c = document.createElement('canvas');
    const shrink = Math.min(1, 900 / Math.max(W, H));
    c.width = Math.round(W * shrink); c.height = Math.round(H * shrink);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    host.innerHTML = `<div class="crop-wrap"><img alt="Your photo" src="${c.toDataURL('image/jpeg', 0.8)}"><div class="crop-box"><i class="h tl"></i><i class="h tr"></i><i class="h bl"></i><i class="h br"></i></div></div>
      <p class="small muted">Drag the corners so the box holds just the nutrition table, from the heading to the sodium row. Leave out the barcode and dates.</p>
      <div class="grid2"><button type="button" class="btn primary" data-crop="read">Read the table</button><button type="button" class="btn" data-crop="cancel">Cancel</button></div>`;
    host.hidden = false;
    const wrap = host.querySelector('.crop-wrap'); const el = host.querySelector('.crop-box');
    const draw = () => { el.style.left = `${(x / W) * 100}%`; el.style.top = `${(y / H) * 100}%`; el.style.width = `${(w / W) * 100}%`; el.style.height = `${(h / H) * 100}%`; };
    draw();
    let drag = null;
    const at = (e) => { const r = wrap.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };
    wrap.onpointerdown = (e) => {
      e.preventDefault();
      const handle = e.target.closest('.h');
      drag = { mode: handle ? [...handle.classList].find((k) => k.length === 2) : (e.target.closest('.crop-box') ? 'move' : null), from: at(e), start: [x, y, w, h] };
      if (!drag.mode) { drag = null; return; }
      wrap.setPointerCapture(e.pointerId);
    };
    wrap.onpointermove = (e) => {
      if (!drag) return;
      const [px, py] = at(e); const dx = px - drag.from[0]; const dy = py - drag.from[1];
      let [sx, sy, sw, sh] = drag.start; const min = Math.min(W, H) * 0.08;
      if (drag.mode === 'move') { sx = Math.max(0, Math.min(W - sw, sx + dx)); sy = Math.max(0, Math.min(H - sh, sy + dy)); }
      if (drag.mode.includes('l')) { const nx = Math.max(0, Math.min(sx + sw - min, sx + dx)); sw += sx - nx; sx = nx; }
      if (drag.mode.includes('r')) sw = Math.max(min, Math.min(W - sx, sw + dx));
      if (drag.mode.includes('t')) { const ny = Math.max(0, Math.min(sy + sh - min, sy + dy)); sh += sy - ny; sy = ny; }
      if (drag.mode.includes('b')) sh = Math.max(min, Math.min(H - sy, sh + dy));
      [x, y, w, h] = [sx, sy, sw, sh]; draw();
    };
    wrap.onpointerup = () => { drag = null; };
    host.querySelector('[data-crop="read"]').onclick = (e) => { e.stopPropagation(); done([x, y, w, h]); };
    host.querySelector('[data-crop="cancel"]').onclick = (e) => { e.stopPropagation(); done(null); };
  });
}

const LABEL_ROWS = [
  // checked in this order: the "of which" rows before "fat", "unsaturated" never counts as saturated
  ['transfat_g', /trans/],
  ['monofat_g', /mono/],
  ['polyfat_g', /poly/],
  ['satfat_g', /(?<!un)satur|versadig/],
  ['sugar_g', /sugar|suiker/],
  ['energy_kj', /energ|kilojoule/],
  ['protein_g', /prote|protien/],
  ['carbs_g', /carbo|hydrat|glycaemic|glycemic|koolhidra/],
  ['cholesterol_mg', /cholest|ch[o0]les/],
  ['fibre_g', /\bfib|vesel/],
  ['sodium_mg', /sodium|natrium|\bs\w{2}[il1]um\b/],
  ['salt_g', /\bsalt\b|\bsout\b/],
  ['fat_g', /\bfat\b|total fat|\bvet\b/],
];
const LABEL_OPTIONAL = ['monofat_g', 'polyfat_g', 'transfat_g', 'cholesterol_mg', 'fibre_g'];   // dropped first when rows are missing

/** Numbers on one line of a label, with the usual reading mistakes undone:
 *  "16.48" (g read as 8) → 16.4, "05" → 0.5, "008" → 0.0, "¢" → g, "ME" → mg, "kd" → kJ. */
function labelNumbers(line) {
  const l = line
    .replace(/\(\s*(?:k\s?j|kcal|m?[g9]|m[li1]|%)\s*\)/gi, ' ')
    .replace(/¢/g, 'g')
    .replace(/(^|\s)[lI|]\s?g\b/g, '$11 g')          // "lg" is "1g"
    .replace(/(\d)\s*(?:ME|Me|mE|m6|M6|MG|m9)\b/g, '$1 mg')
    .replace(/(\d)\s*k[dJjl1]\b/g, '$1 kJ')
    .replace(/(\d)\s?m[i1](?=\b|\s)/g, '$1 ml')
    .replace(/(\d)[oO](?=\d|\b)/g, '$10').replace(/(^|[\s(<])[oO](?=[.,]\d)/g, '$10').replace(/(\d)[lI|](?=\d)/g, '$11')
    .replace(/(\d),(\d)/g, '$1.$2').replace(/(\d)\s+\.(\d)/g, '$1.$2');
  const per100 = /per\s*100/i.test(l);
  const out = [];
  for (const m of l.matchAll(/(<?)\s*(\d+(?:\.\d+)?)\s*(kj|kcal|cal|mg|g|ml|%)?/gi)) {
    let d = m[2]; let unit = (m[3] || '').toLowerCase();
    if (unit === '%') continue;
    if (!d.includes('.') && d.length >= 2 && d[0] === '0') {
      if (d.length >= 3 && /[89]$/.test(d) && !unit) { d = d.slice(0, -1); unit = 'g'; }
      d = `${d[0]}.${d.slice(1)}`;
    } else if (d.includes('.') && !unit && d.split('.')[1].length >= 2 && /[89]$/.test(d)) {
      d = d.slice(0, -1); unit = 'g';
    }
    const v = parseFloat(d);
    if (per100 && v === 100 && (unit === 'g' || unit === 'ml' || !unit)) continue;
    out.push({ v, unit, lt: m[1] === '<' });
  }
  return out;
}

/** Turn the text of a nutrition table into per-100 g values.
 *  Rows are matched by name; rows whose name didn't read are placed by the label's fixed order between the rows
 *  that did. Values come from the right-hand columns, and the per serving column is used to catch lost decimal points. */
function parseLabelText(raw) {
  const lines = String(raw).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const order = NUTRIENTS.map(([k]) => k);
  let servingFirst = false; let cols = 1; let started = false; let pending = null;
  const rows = [];
  for (const line of lines) {
    const L = line.toLowerCase().replace(/¢/g, 'g');
    if (/method|analysis|aoac|manufactured|produced by|distributed by/.test(L) && rows.length) break;
    if (rows.some((r) => r.key === 'sodium_mg' || r.key === 'salt_g') && rows.length >= 4) break;   // sodium is the last row
    const head100 = L.search(/per\s*100|100\s*(g|ml|mi)\b/);
    if (head100 >= 0 && !/\d+\s*k\s?j/.test(L)) {
      started = true;
      cols = (L.match(/\bper\b|serv|portion/g) || []).length >= 2 ? 2 : cols;
      const srv = L.search(/serv|portion|portie/);
      if (srv >= 0 && srv < head100) servingFirst = true;
      continue;
    }
    if (/nutri|average values|typical/.test(L)) { started = true; continue; }
    let key = (LABEL_ROWS.find(([, re]) => re.test(L)) || [null])[0];
    if (key === 'fat_g' && /satur|trans|mono|poly/.test(L)) key = null;
    if (key === 'carbs_g' && /sugar/.test(L)) key = 'sugar_g';
    const nums = labelNumbers(line);
    if (!nums.length) { if (key) pending = key; continue; }
    if (!key && pending) key = pending;
    pending = null;
    const kj = nums.filter((n) => n.unit === 'kj');
    if (!key && kj.length) key = 'energy_kj';
    if (!key && !started) continue;
    started = true;
    if (key === 'energy_kj' && kj.length >= 2) cols = 2;
    rows.push({ key, nums, kj, mg: nums.some((n) => n.unit === 'mg') });
  }
  // the per 100 g value of a row: from the right-hand columns
  const pick = (r) => {
    if (r.key === 'energy_kj') {
      const kj = r.kj.length ? r.kj : r.nums.filter((n) => n.unit === 'kcal' || n.unit === 'cal').map((n) => ({ ...n, v: Math.round(n.v * 4.184) }));
      const use = kj.length ? kj : r.nums;
      const pair = cols === 1 ? use.slice(0, 1) : use.slice(-2);
      return { v100: (servingFirst ? pair[1] || pair[0] : pair[0]), vServ: pair.length > 1 ? (servingFirst ? pair[0] : pair[1]) : null };
    }
    // numbers with a unit are the columns; bare numbers are usually dates, codes or bits of the row name
    const withUnit = r.nums.filter((n) => n.unit);
    const src = withUnit.length >= Math.min(cols, 2) ? withUnit : r.nums;
    if (cols === 2 && src.length < 2) return { v100: null, vServ: null };   // one number where there should be two: a misread, leave it
    if (cols === 1) return { v100: src[0], vServ: null };
    const pair = src.slice(-2);
    return { v100: servingFirst ? pair[1] || pair[0] : pair[0], vServ: pair.length > 1 ? (servingFirst ? pair[0] : pair[1]) : null };
  };
  if (cols === 1) {
    const withTwo = rows.filter((r) => r.nums.length >= 2).length;
    if (withTwo >= Math.max(2, rows.length / 2)) cols = 2;
  }
  for (const r of rows) Object.assign(r, pick(r));
  // per 100 g ÷ per serving, from the energy row: every row should keep that ratio
  const en = rows.find((r) => r.key === 'energy_kj' && r.vServ && r.vServ.v > 0);
  const ratio = en && en.v100.v > en.vServ.v ? en.v100.v / en.vServ.v : null;
  const derived = new Set();
  for (const r of rows) {
    if (!ratio || r.key === 'energy_kj' || !r.vServ || !(r.vServ.v > 0) || !r.v100) continue;
    const q = r.v100.v / (r.vServ.v * ratio);
    if (q > 6 && q < 16) r.v100 = { ...r.v100, v: r.v100.v / 10 };
    else if (q > 60 && q < 160) r.v100 = { ...r.v100, v: r.v100.v / 100 };
    else if ((q < 0.6 || q > 1.6) && !(q > 0.06 && q < 0.16) && !r.v100.unit && r.vServ.unit) {
      r.v100 = { v: Math.round(r.vServ.v * ratio * 10) / 10, unit: r.vServ.unit }; r.derived = true;
    }
  }
  // place rows whose names didn't read, by the label's order between rows that did
  for (const r of rows) if (r.key === 'salt_g') { r.key = 'sodium_mg'; r.fromSalt = true; }
  const used = new Set();
  for (const r of rows) { if (r.key && used.has(r.key)) r.key = null; else if (r.key) used.add(r.key); }
  let i = 0;
  while (i < rows.length) {
    if (rows[i].key) { i++; continue; }
    let j = i; while (j < rows.length && !rows[j].key) j++;
    const before = i > 0 ? order.indexOf(rows[i - 1].key) : -1;
    const after = j < rows.length ? order.indexOf(rows[j].key) : order.length;
    const gap = rows.slice(i, j);
    let cands = order.slice(before + 1, after).filter((k) => !used.has(k));
    for (const k of LABEL_OPTIONAL) { if (cands.length <= gap.length) break; if (cands.includes(k)) cands = cands.filter((c) => c !== k); }
    if (cands.length === gap.length) {
      gap.forEach((r, n) => {
        const k = cands[n];
        const mgKey = k === 'cholesterol_mg' || k === 'sodium_mg';
        if (r.mg && !mgKey) return;
        r.key = k; used.add(k);
      });
    }
    i = j;
  }
  const values = {}; const guessed = [];
  for (const r of rows) {
    if (!r.key || !r.v100) continue;
    let v = r.v100.v;
    if (r.fromSalt) v = Math.round(v * 400);
    else if (r.key === 'sodium_mg' && r.v100.unit === 'g') v *= 1000;
    values[r.key] = v;
    if (r.derived) guessed.push(r.key);
  }
  const limits = { energy_kj: 3800, sodium_mg: 40000, cholesterol_mg: 5000 };
  for (const k of Object.keys(values)) if (!(values[k] >= 0) || values[k] > (limits[k] || 100)) delete values[k];
  if (values.satfat_g !== undefined && values.fat_g !== undefined && values.satfat_g > values.fat_g + 0.5) delete values.satfat_g;
  if (values.sugar_g !== undefined && values.carbs_g !== undefined && values.sugar_g > values.carbs_g + 0.5) delete values.sugar_g;
  return { values, servingFirst, found: Object.keys(values).length, guessed: guessed.filter((k) => k in values) };
}
/** The ingredients list from a photo: everything after "Ingredients" up to allergens/storage/nutrition text. */
function extractIngredients(raw) {
  const t = String(raw).replace(/\s*\n\s*/g, ' ');
  const m = t.match(/ingredi[eë]nt[se]?\s*[:;.\-]?\s*(.+)/i);
  if (!m) return '';
  const body = m[1].split(/\b(?:allergens?|contains|may contain|nutrition|typical|storage|store in|keep refrigerated|best before|use by|manufactured|produced|packed|warning)/i)[0];
  const clean = body.replace(/\s{2,}/g, ' ').replace(/[|]/g, 'l').trim()
    .replace(/^[^A-Za-z]*(?:\b[A-Za-z]{1,2}\b[^A-Za-z]*)*(?=[A-Za-z]{3})/, '')   // bits of the label's edge before the first word
    .replace(/(?:\s+[^\s]{1,2})+\s*$/, (m) => (/\b(E\d|\d+%)/.test(m) ? m : ''))     // and after the last
    .replace(/[\s.;,:*\-—–]+$/, '');
  return clean.length > 10 ? clean.slice(0, 4000) : '';
}

/* ----- the shared catalogue: your products are on the phone, the rest are a search away ----- */
const searchedTerms = new Set();
/** Ask the server for catalogue products matching a search; resolves true when new ones arrived. */
async function fetchCatalogue(q) {
  const term = q.trim().toLowerCase();
  if (term.length < 2 || searchedTerms.has(term)) return false;
  searchedTerms.add(term);
  try {
    const { products } = await api('products.search', { q: term });
    let added = false;
    for (const p of products) if (!S.products.some((x) => x.id === p.id)) { S.products.push(p); added = true; }
    return added;
  } catch { searchedTerms.delete(term); return false; }
}
let catalogueTimer = null;
/** Debounced: after typing stops, look further and redraw if anything new turned up. */
function searchFurther(q, redraw) {
  clearTimeout(catalogueTimer);
  catalogueTimer = setTimeout(async () => { if (await fetchCatalogue(q)) redraw(); }, 300);
}

/* ----- at home: plenty, low or out, instead of grams nobody keeps up to date ----- */
/** Roughly what's at home: half a pack or more is plenty. null for things you've never had. */
function pantryState(p) {
  if (!(p.pantry > 0) && !p.bought_count) return null;
  if (!(p.pantry > 0)) return 'out';
  return p.pantry < (p.pack_size || 1) * 0.5 ? 'low' : 'plenty';
}
const PANTRY_LABEL = { plenty: 'Plenty at home', low: 'Low', out: 'Out' };
const PANTRY_NEXT = { plenty: 'low', low: 'out', out: 'plenty' };
const pantryAmountFor = (p, st) => (st === 'plenty' ? (p.pack_size || 1) : st === 'low' ? (p.pack_size || 1) * 0.25 : 0);
const pantryChip = (p) => { const st = pantryState(p); return st ? `<button type="button" class="home-chip home-${st}" data-pantry="${p.id}" aria-label="${esc(p.name)}: ${PANTRY_LABEL[st]}. Tap to change">${PANTRY_LABEL[st]}</button>` : ''; };
/** Buy again: low things, and things that ran out lately or that you buy regularly. Never hundreds. */
function buyAgain(onList) {
  const recent = (p) => p.pantry_at && (Date.now() - new Date(String(p.pantry_at).replace(' ', 'T')).getTime()) < 21 * 86400000;
  return S.products.filter((p) => !onList.has(p.id) && !p.skip_again && (pantryState(p) === 'low' || (pantryState(p) === 'out' && (recent(p) || (p.bought_count || 0) >= 2))))
    .sort((a, b) => String(b.pantry_at || '').localeCompare(String(a.pantry_at || '')) || (b.bought_count || 0) - (a.bought_count || 0))
    .slice(0, 20);
}

/** How much is at home: Plenty / Low / Out, or an exact number of packs. Every change can be undone. */
function homeSheet(p, done = () => route()) {
  const pack = p.pack_size || 1;
  const unit = p.unit || 'each';
  const packs = (p.pantry || 0) / pack;
  const st = pantryState(p) || 'out';
  openSheet(`${sheetHead(p.name)}
    <p class="small muted">How much is at home? Cooking and logging food take from this for you.</p>
    <div class="seg3">${['plenty', 'low', 'out'].map((k) => `<button type="button" class="btn ${k === st ? 'primary' : ''}" data-set="${k}">${k === 'plenty' ? 'Plenty' : k === 'low' ? 'Low' : 'Out'}</button>`).join('')}</div>
    <form class="stack" id="homeForm">
      <label>Packs at home${pack !== 1 || unit !== 'each' ? ` <span class="muted small">(1 pack = ${fmtQty(pack)} ${esc(unit)})</span>` : ''}
        <div class="row"><button type="button" class="btn" data-step="-0.5" aria-label="Half a pack less">−</button><input name="packs" class="grow center" inputmode="decimal" value="${Math.round(packs * 100) / 100}"><button type="button" class="btn" data-step="0.5" aria-label="Half a pack more">+</button></div></label>
      <button class="btn primary block">Save</button>
    </form>`);
  const form = document.getElementById('homeForm');
  const save = async (amount) => {
    const before = p.pantry || 0;
    await api('pantry.set', { product_id: p.id, amount });
    p.pantry = amount; p.pantry_at = new Date().toISOString().slice(0, 19).replace('T', ' '); if (!p.bought_count) p.bought_count = 1;
    if (amount > 0) p.skip_again = false;
    closeSheet(); done();
    const now = pantryState(p);
    undoToast(now === 'out' ? `${p.name} is out (it's under Buy again in Shop)` : `${p.name}: ${PANTRY_LABEL[now]}`, async () => {
      await api('pantry.set', { product_id: p.id, amount: before }); p.pantry = before; done();
    });
  };
  sheetBody.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.set) return await save(pantryAmountFor(p, b.dataset.set));
      if (b.dataset.step) { const v = Math.max(0, (parseFloat(String(form.packs.value).replace(',', '.')) || 0) + Number(b.dataset.step)); form.packs.value = Math.round(v * 100) / 100; }
    } catch (er) { fail(er); }
  };
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const v = parseFloat(String(form.packs.value).replace(',', '.'));
    if (!(v >= 0)) return toast('Type a number of packs, like 1 or 0.5');
    try { await save(Math.round(v * pack * 1000) / 1000); } catch (er) { fail(er); }
  };
}

/** Tap the chip: plenty → low → out → plenty. */
async function cyclePantry(p) {
  const next = PANTRY_NEXT[pantryState(p) || 'out'];
  const amount = pantryAmountFor(p, next);
  await api('pantry.set', { product_id: p.id, amount });
  p.pantry = amount;
  if (!p.bought_count) p.bought_count = 1;
  return next;
}

/* ----- ingredient units: type "100 g" of a cheese bought per kg ----- */
const ING_UNITS = { g: ['mass', 1], kg: ['mass', 1000], ml: ['vol', 1], l: ['vol', 1000], tsp: ['vol', 5], tbsp: ['vol', 15], cup: ['vol', 250], each: ['count', 1] };
const ING_LABEL = { g: 'g', kg: 'kg', ml: 'ml', l: 'litre', tsp: 'tsp', tbsp: 'tbsp', cup: 'cup', each: 'each', pack: 'pack' };
/** The units that make sense for a product, most likely first. */
function ingUnitsFor(p) {
  const fam = (ING_UNITS[p.unit] || ['count'])[0];
  if (fam === 'mass') return ['g', 'kg', 'pack', 'ml'];
  if (fam === 'vol') return ['ml', 'l', 'tsp', 'tbsp', 'cup', 'pack', 'g'];
  return ['each', 'pack'];
}
/** An amount in any unit → the product's own unit (1 g counted as 1 ml between weight and volume). */
function ingToProductUnit(qty, unit, p) {
  if (unit === 'pack') return qty * (p.pack_size || 1);
  const from = ING_UNITS[unit]; const to = ING_UNITS[p.unit];
  if (!from || !to) return null;
  if (from[0] !== to[0] && (from[0] === 'count' || to[0] === 'count')) return null;
  return (qty * from[1]) / to[1];
}
/** How an ingredient line reads: "100 g", "2 tbsp", "½ pack", or the old product-unit amount. */
function ingLabel(it) {
  if (it.qty !== null && it.qty !== undefined && it.qty_unit) {
    const q = it.qty_unit === 'kg' && it.qty < 1 ? [it.qty * 1000, 'g'] : it.qty_unit === 'g' && it.qty >= 1000 ? [it.qty / 1000, 'kg'] : [it.qty, it.qty_unit];
    if (q[1] === 'pack') return `${fmtQty(q[0])} pack${q[0] > 1 ? 's' : ''}`;
    if (q[1] === 'each') return `${fmtQty(q[0])}×`;
    if (q[1] === 'cup') return `${fmtQty(q[0])} cup${q[0] > 1 ? 's' : ''}`;
    return `${round(q[0], q[0] < 10 ? 2 : 0)} ${q[1]}`;
  }
  return fmtAmount(it.amount, it.unit);
}

function fmtAmount(amount, unit) {
  if (unit === 'g' && amount >= 1000) return `${round(amount / 1000, 2)} kg`;
  if (unit === 'ml' && amount >= 1000) return `${round(amount / 1000, 2)} l`;
  if (unit === 'each') return `${round(amount, 1)}×`;
  return `${round(amount, 2)} ${unit}`;
}

/** Plan and Recipes share the Plan tab. */
const planSwitch = (on) => `<nav class="seg plan-switch" aria-label="Plan or recipes"><a href="#plan" class="${on === 'plan' ? 'on' : ''}" ${on === 'plan' ? 'aria-current="page"' : ''}>Week</a><a href="#recipes" class="${on === 'recipes' ? 'on' : ''}" ${on === 'recipes' ? 'aria-current="page"' : ''}>Recipes</a></nav>`;

async function renderPlan() {
  const start = parseIso(store.get('planWeek', iso(mondayOf(new Date()))));
  const end = addDays(start, 6);
  const [{ entries }, { recipes }, { fridge }] = await Promise.all([
    api('plan.get', { from: iso(start), to: iso(end) }),
    api('recipes.list'),
    api('fridge.list'),
  ]);
  S.recipes = recipes;
  const today = iso(new Date());
  const keys = [0, 1, 2, 3, 4, 5, 6].map((i) => iso(addDays(start, i)));
  let sel = store.get('planDay', null);
  if (!keys.includes(sel)) sel = keys.includes(today) ? today : keys[0];
  store.set('planDay', sel);

  const weekCost = entries.reduce((s, e) => s + e.cost, 0);
  const weekBudget = S.budget * 12 / 52;
  const dayEntries = entries.filter((e) => e.date === sel);
  const dayCost = dayEntries.reduce((s, e) => s + e.cost, 0);
  const dayProtein = dayEntries.reduce((s, e) => s + e.protein_g, 0);
  const selDate = parseIso(sel);
  const range = `${start.getDate()} ${start.toLocaleDateString('en-ZA', { month: 'short' })} – ${end.getDate()} ${end.toLocaleDateString('en-ZA', { month: 'short' })}`;

  // prep day: planned (not yet eaten) portions per recipe, minus what's already in the fridge
  const recipeById = Object.fromEntries(recipes.map((r) => [r.id, r]));
  const prep = prepRows(entries, fridge, recipeById);
  const toCook = prep.reduce((s, p) => s + p.cook, 0);

  view.innerHTML = `
    <div class="plan-head">
      <div class="stack tight">
        <span class="small muted">${esc(range)}</span>
        <h1>Meal plan</h1>
      </div>
      <div class="right">
        <div class="week-cost ${weekCost > weekBudget ? 'over' : ''}">${money0(weekCost)}</div>
        <div class="small muted">of ${money0(weekBudget)} this week</div>
      </div>
    </div>

    ${planSwitch('plan')}
    <button class="btn ${entries.length ? '' : 'primary'} block" data-act="wizard">${entries.length ? 'Re-plan this week' : 'Plan my week'}</button>

    <div class="row between">
      <div class="week-nav">
        <button type="button" data-act="prev" aria-label="Previous week">‹</button>
        <button type="button" data-act="next" aria-label="Next week">›</button>
      </div>
      <div class="row">
        ${keys.includes(today) ? '' : '<button class="btn small" data-act="now">This week</button>'}
        <button class="btn small" data-act="copy" ${entries.length ? '' : 'disabled'}>Repeat next week</button>
      </div>
    </div>

    <div class="daystrip">${keys.map((k) => {
      const d = parseIso(k);
      const n = entries.filter((e) => e.date === k).length;
      return `<button type="button" class="daybtn ${k === sel ? 'active' : ''} ${k === today ? 'today' : ''} ${n ? '' : 'empty'}" data-day="${k}" aria-pressed="${k === sel}" aria-label="${dayName(d)}, ${n} meal${n === 1 ? '' : 's'}">
        <span class="d">${'MTWTFSS'[(d.getDay() + 6) % 7]}</span><b>${d.getDate()}</b>${n ? `<span class="mark" data-n="${n}"></span>` : ''}</button>`;
    }).join('')}</div>

    <section class="card stack">
      <div class="heading-row">
        <h2>${esc(selDate.toLocaleDateString('en-ZA', { weekday: 'long' }))}</h2>
        <span class="small muted">${dayEntries.length ? money(dayCost) : 'Nothing planned'}</span>
      </div>
      ${dayEntries.map((e) => `<div class="meal ${e.eaten ? 'eaten' : ''}">
        <button type="button" class="eat-btn ${e.eaten ? 'on' : ''}" data-eat="${e.id}" data-eaten="${e.eaten ? 1 : 0}" aria-pressed="${e.eaten}" aria-label="${e.eaten ? 'Undo eaten' : 'Mark eaten'}: ${esc(e.recipe)}">✓</button>
        <div class="grow"><div class="strong">${esc(e.recipe)}${e.servings !== 1 ? ` <span class="muted">×${fmtQty(e.servings)}</span>` : ''}</div><div class="small muted"><span class="cap">${esc(e.slot)}</span>${e.protein_g ? ` · ${Math.round(e.protein_g)} g protein` : ''}</div></div>
        <span class="num strong">${money(e.cost)}</span>
        <button class="icon-btn" data-del="${e.id}" aria-label="Remove ${esc(e.recipe)}">✕</button>
      </div>`).join('')}
      ${dayProtein ? perPersonHtml(dayEntries) : ''}
      <button class="btn small" data-add="${sel}">＋ Add a meal</button>
    </section>

    ${prep.length ? `<section class="prep-card">
      ${ICON_POT}
      <div class="grow stack">
        <span class="strong">Prep day</span>
        <div class="stack tight">${prep.map((p) => `<div class="row between small"><span>${esc(p.recipe.name)}</span><span class="muted">need ${fmtQty(p.planned)}${p.fridge ? ` · ${fmtQty(p.fridge)} in fridge` : ''} · <b class="${p.cook ? 'warn-text' : 'good-text'}">${p.cook ? `cook ${fmtQty(p.cook)}` : 'covered'}</b></span></div>`).join('')}</div>
        ${toCook ? '<button class="btn small" data-act="prep">Start prep day</button>' : '<span class="small good-text">Everything planned is already in the fridge.</span>'}
      </div>
    </section>` : ''}

    <button class="btn primary block" data-act="to-list" ${entries.length ? '' : 'disabled'}>Put the week on my list</button>`;

  view.querySelectorAll('.mark').forEach((m) => { m.style.width = `${Math.min(30, 6 + Number(m.dataset.n) * 6)}px`; });
  view.querySelectorAll('[data-w]').forEach((m) => { m.style.width = `${m.dataset.w}%`; });

  view.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-add],[data-del],[data-day],[data-eat]');
    if (!t) return;
    try {
      if (t.dataset.eat) { await eatMeal(t.dataset.eat, t.dataset.eaten === '1'); return renderPlan(); }
      if (t.dataset.act === 'prep') return prepSession(prep.filter((p) => p.cook > 0), () => renderPlan());
      if (t.dataset.act === 'wizard') return planWizard(start, recipes, entries);
      if (t.dataset.day) { store.set('planDay', t.dataset.day); return renderPlan(); }
      if (t.dataset.add) return planAddSheet(t.dataset.add);
      if (t.dataset.del) { await api('plan.delete', { id: t.dataset.del }); return renderPlan(); }
      switch (t.dataset.act) {
        case 'prev': store.set('planWeek', iso(addDays(start, -7))); break;
        case 'next': store.set('planWeek', iso(addDays(start, 7))); break;
        case 'now': store.set('planWeek', iso(mondayOf(new Date()))); store.set('planDay', today); break;
        case 'to-list': {
          if (!confirm('Replace the plan items on your shopping list with what this week needs?')) return;
          const r = await api('plan.to_list', { from: iso(start), to: iso(end) });
          toast(`${r.added} item${r.added === 1 ? '' : 's'} on the list`);
          location.hash = '#shop';
          return;
        }
        case 'copy': {
          const r = await api('plan.copy_week', { from: iso(start) });
          toast(`Copied ${r.copied} meals to next week`);
          store.set('planWeek', iso(addDays(start, 7)));
          break;
        }
        default: return;
      }
      renderPlan();
    } catch (er) { fail(er); }
  };
}

/** What you eat on a day: one portion of each planned meal (extra servings are for someone else or leftovers). */
function perPersonHtml(dayEntries) {
  const portion = (e, k) => e[k] / Math.max(1, e.servings || 1);
  const protein = dayEntries.reduce((s, e) => s + portion(e, 'protein_g'), 0);
  const kj = dayEntries.reduce((s, e) => s + portion(e, 'energy_kj'), 0);
  const me = S.users.find((u) => u.id === S.user.id) || {};
  const bar = (v, t) => (t ? `<div class="meter ${v < t * 0.8 ? 'warn' : ''}"><div data-w="${Math.min(100, (v / t) * 100)}"></div></div>` : '');
  return `<div class="stack tight small">
      <div class="row between"><span class="muted">You eat</span><span><b>${Math.round(protein)} g</b> protein · <b>${Math.round(kj).toLocaleString('en-ZA')}</b> kJ</span></div>
      ${me.protein_target_g ? `<div class="row between"><span class="muted">Your protein target</span><span>${me.protein_target_g} g</span></div>${bar(protein, me.protein_target_g)}` : ''}
      ${me.kj_target ? `<div class="row between"><span class="muted">Your kJ target</span><span>${me.kj_target.toLocaleString('en-ZA')} kJ</span></div>${bar(kj, me.kj_target)}` : ''}
      ${!me.protein_target_g && !me.kj_target ? '<span class="muted">Set your daily targets under Me (your initial at the top).</span>' : ''}
    </div>`;
}

/** Plan my week: pick days, people and recipes per meal; the app spreads them out in prep-friendly runs. */
function planWizard(start, recipes, existing) {
  if (!recipes.length) { toast('Add a recipe first'); location.hash = '#recipes'; return; }
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => iso(addDays(start, i)));
  const saved = store.get('wizard', {});
  const valid = (ids) => (ids || []).filter((id) => recipes.some((r) => r.id === id));
  const st = {
    days: saved.dayMask ? days.filter((_, i) => saved.dayMask[i]) : [...days],
    people: saved.people || 1,
    breakfast: valid([saved.breakfast])[0] || null,
    lunch: valid(saved.lunch),
    dinner: valid(saved.dinner),
    batch: saved.batch || 2,
    mode: existing.length ? 'fill' : 'replace',
  };
  const byId = Object.fromEntries(recipes.map((r) => [r.id, r]));
  const build = () => {
    const out = [];
    const same = st.lunch.length > 1 && st.lunch.join() === st.dinner.join();
    st.days.forEach((d, i) => {
      const block = Math.floor(i / st.batch);
      if (st.breakfast) out.push({ date: d, slot: 'breakfast', recipe_id: st.breakfast, servings: st.people });
      if (st.lunch.length) out.push({ date: d, slot: 'lunch', recipe_id: st.lunch[block % st.lunch.length], servings: st.people });
      if (st.dinner.length) out.push({ date: d, slot: 'dinner', recipe_id: st.dinner[(block + (same ? 1 : 0)) % st.dinner.length], servings: st.people });
    });
    return out;
  };
  const chips = (key) => recipes.map((r) => `<button type="button" class="chip ${st[key].includes(r.id) ? 'active' : ''}" data-pick="${key}" data-id="${r.id}" aria-pressed="${st[key].includes(r.id)}">${esc(r.name)}</button>`).join('');
  const draw = () => {
    const plan = build();
    const cost = plan.reduce((s, e) => s + (byId[e.recipe_id].cost_per_serving * e.servings), 0);
    const weekBudget = S.budget * 12 / 52;
    const perDay = {};
    for (const e of plan) {
      const n = byId[e.recipe_id].nutrition_per_serving || {};
      perDay[e.date] = (perDay[e.date] || 0) + (n.protein_g || 0);
    }
    const avgProtein = st.days.length ? Object.values(perDay).reduce((a, b) => a + b, 0) / st.days.length : 0;
    const me = S.users.find((u) => u.id === S.user.id) || {};
    const keepY = sheetBody.scrollTop;
    openSheet(`${sheetHead('Plan my week')}
      <div class="stack tight"><span class="small muted">Days</span>
        <div class="daystrip">${days.map((d) => { const dt = parseIso(d); const on = st.days.includes(d); return `<button type="button" class="daybtn ${on ? 'active' : 'empty'}" data-day="${d}" aria-pressed="${on}"><span class="d">${'MTWTFSS'[(dt.getDay() + 6) % 7]}</span><b>${dt.getDate()}</b></button>`; }).join('')}</div>
      </div>
      <div class="row between"><span>Portions per meal</span><div class="qty big"><button type="button" data-act="p-">−</button><span>${st.people}</span><button type="button" data-act="p+">+</button></div></div>
      <label>Breakfast <select id="wzB"><option value="">Skip breakfast</option>${recipes.map((r) => `<option value="${r.id}" ${r.id === st.breakfast ? 'selected' : ''}>${esc(r.name)} (${money(r.cost_per_serving)})</option>`).join('')}</select></label>
      <div class="stack tight"><span class="small muted">Lunch: pick one or more to rotate</span><div class="chips wrap">${chips('lunch')}</div></div>
      <div class="stack tight"><span class="small muted">Dinner: pick one or more to rotate</span><div class="chips wrap">${chips('dinner')}</div></div>
      <div class="row between"><span>Same recipe for</span><div class="qty big"><button type="button" data-act="b-">−</button><span>${st.batch}</span><button type="button" data-act="b+">+</button></div></div>
      <p class="small muted">Runs of ${st.batch} day${st.batch > 1 ? 's' : ''} per recipe make prep easier: one batch covers several meals.</p>
      ${existing.length ? `<div class="chips wrap"><button type="button" class="chip ${st.mode === 'fill' ? 'active' : ''}" data-mode="fill">Only fill empty meals</button><button type="button" class="chip ${st.mode === 'replace' ? 'active' : ''}" data-mode="replace">Replace this week's plan</button></div>` : ''}
      <section class="card stack">
        <div class="row between"><span>${plan.length} meals</span><b class="num ${cost > weekBudget ? 'bad-text' : 'good-text'}">${money(cost)}</b></div>
        <div class="row between small muted"><span>Weekly share of budget</span><span class="num">${money(weekBudget)}</span></div>
        ${cost > weekBudget ? `<p class="small bad-text">Over by ${money(cost - weekBudget)}. Swap in a cheaper recipe or plan fewer meals.</p>` : ''}
        <div class="row between small"><span class="muted">Protein per person a day</span><span>${Math.round(avgProtein)} g${me.protein_target_g ? ` <span class="muted">/ ${me.protein_target_g} g target</span>` : ''}</span></div>
        <div class="stack tight small">${st.days.map((d) => { const dt = parseIso(d); const ms = plan.filter((e) => e.date === d); return `<div class="row"><span class="muted wz-day">${dt.toLocaleDateString('en-ZA', { weekday: 'short' })}</span><span class="grow">${ms.map((e) => esc(byId[e.recipe_id].name)).join(' · ') || '<span class="muted">nothing</span>'}</span></div>`; }).join('')}</div>
      </section>
      <button class="btn primary block" data-act="save" ${plan.length ? '' : 'disabled'}>Save plan</button>`);
    sheetBody.scrollTop = keepY;
    const sel = document.getElementById('wzB');
    sel.onchange = () => { st.breakfast = sel.value ? Number(sel.value) : null; draw(); };
    sheetBody.onclick = async (e) => {
      const t = e.target.closest('[data-act],[data-pick],[data-day],[data-mode]');
      if (!t) return;
      if (t.dataset.day) { const d = t.dataset.day; st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : days.filter((x) => x === d || st.days.includes(x)); return draw(); }
      if (t.dataset.pick) { const k = t.dataset.pick; const id = Number(t.dataset.id); st[k] = st[k].includes(id) ? st[k].filter((x) => x !== id) : [...st[k], id]; return draw(); }
      if (t.dataset.mode) { st.mode = t.dataset.mode; return draw(); }
      switch (t.dataset.act) {
        case 'p-': st.people = Math.max(1, st.people - 1); return draw();
        case 'p+': st.people = Math.min(12, st.people + 1); return draw();
        case 'b-': st.batch = Math.max(1, st.batch - 1); return draw();
        case 'b+': st.batch = Math.min(7, st.batch + 1); return draw();
        case 'save':
          try {
            store.set('wizard', { dayMask: days.map((d) => st.days.includes(d)), people: st.people, breakfast: st.breakfast, lunch: st.lunch, dinner: st.dinner, batch: st.batch });
            const r = await api('plan.bulk', { entries: plan, mode: st.mode });
            closeSheet();
            toast(`${r.added} meal${r.added === 1 ? '' : 's'} planned. Next: put the week on your list`);
            renderPlan();
          } catch (er) { fail(er); }
          return;
        default:
      }
    };
  };
  draw();
}

function prepRows(entries, fridge, recipeById) {
  const by = {};
  for (const e of entries) {
    if (e.eaten || !recipeById[e.recipe_id]) continue;
    by[e.recipe_id] = by[e.recipe_id] || { recipe: recipeById[e.recipe_id], planned: 0, fridge: 0 };
    by[e.recipe_id].planned += e.servings;
  }
  for (const f of fridge) if (f.recipe_id && by[f.recipe_id]) by[f.recipe_id].fridge += f.portions;
  return Object.values(by).map((p) => ({ ...p, cook: Math.max(0, Math.ceil(p.planned - p.fridge - 1e-9)) }))
    .sort((a, b) => b.cook - a.cook);
}

async function eatMeal(id, undo) {
  const r = await api('plan.eat', { id, undo });
  if (undo) toast(r.returned ? `Put ${fmtQty(r.returned)} back in the fridge` : 'Marked not eaten');
  else toast(r.taken ? `Took ${fmtQty(r.taken)} from the fridge` : 'Marked eaten (none were in the fridge)');
}

/** Prep day: choose portions per recipe, gather everything at once, then cook each recipe in turn. */
function prepSession(rows, onFinish) {
  const plan = rows.map((p) => ({ recipe: p.recipe, n: p.cook }));
  const drawPick = () => {
    const active = plan.filter((p) => p.n > 0);
    const cost = active.reduce((s, p) => s + scaleRecipe(p.recipe, p.n).used, 0);
    openSheet(`${sheetHead('Prep day')}
      <p class="small muted">Portions to cook, after what's already in the fridge. Change them if you want extra.</p>
      <ul class="list card flush">${plan.map((p, i) => `<li data-i="${i}">
        <div class="grow"><div class="name">${esc(p.recipe.name)}</div><div class="sub">${money(p.recipe.cost_per_serving)} a portion${recipeSteps(p.recipe).length ? ` · ${recipeSteps(p.recipe).length} steps` : ''}</div></div>
        <div class="qty"><button type="button" data-act="dec" aria-label="Fewer">−</button><span>${fmtQty(p.n)}</span><button type="button" data-act="inc" aria-label="More">+</button></div></li>`).join('')}</ul>
      <div class="row between"><span class="muted">${fmtQty(active.reduce((s, p) => s + p.n, 0))} portions</span><b class="num">${money(cost)}</b></div>
      <button class="btn primary block" data-act="gather" ${active.length ? '' : 'disabled'}>Gather everything</button>`);
    sheetBody.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const li = a.closest('li');
      if (a.dataset.act === 'inc') { plan[li.dataset.i].n += 1; return drawPick(); }
      if (a.dataset.act === 'dec') { plan[li.dataset.i].n = Math.max(0, plan[li.dataset.i].n - 1); return drawPick(); }
      if (a.dataset.act === 'gather') return drawGather(active);
    };
  };
  const drawGather = (active) => {
    const sum = {};
    for (const p of active) {
      for (const it of scaleRecipe(p.recipe, p.n).items) {
        sum[it.product_id] = sum[it.product_id] || { name: it.name, unit: it.unit, amount: 0 };
        sum[it.product_id].amount += it.amount;
      }
    }
    openSheet(`${sheetHead('Gather everything')}
      <p class="small muted">For ${active.map((p) => `${fmtQty(p.n)} × ${esc(p.recipe.name)}`).join(', ')}.</p>
      <ul class="ing-list check">${Object.values(sum).sort((a, b) => a.name.localeCompare(b.name)).map((it) => `<li><label class="row grow"><input type="checkbox"><span class="amt num">${fmtAmount(it.amount, it.unit)}</span><span class="grow">${esc(it.name)}</span></label></li>`).join('')}</ul>
      <button class="btn primary block" data-act="go">Cook ${esc(active[0].recipe.name)}</button>
      <button class="btn block" data-act="back">Back</button>`);
    sheetBody.classList.add('full');
    sheetBody.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'back') return drawPick();
      if (a.dataset.act === 'go') { closeSheet(); cookNext(active, 0); }
    };
  };
  const cookNext = (active, i) => {
    if (i >= active.length) {
      toast(`Prep done: ${fmtQty(active.reduce((s, p) => s + p.n, 0))} portions in the fridge`);
      if (onFinish) onFinish();
      return;
    }
    cookMode(active[i].recipe, active[i].n, {
      skipGather: true,
      label: `Recipe ${i + 1} of ${active.length}`,
      onDone: () => cookNext(active, i + 1),
    });
  };
  drawPick();
}

async function planAddSheet(date, recipeId = null) {
  if (!S.recipes) S.recipes = (await api('recipes.list')).recipes;
  if (!S.recipes.length) { toast('Add a recipe first'); location.hash = '#recipes'; return; }
  openSheet(`${sheetHead('Add meal')}
    <form class="stack" id="plForm">
      <label>Day <input name="date" type="date" value="${date}"></label>
      <label>Meal <select name="slot">${SLOTS.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label>
      <label>Recipe <select name="recipe_id">${S.recipes.map((r) => `<option value="${r.id}" ${r.id === recipeId ? 'selected' : ''}>${esc(r.name)} (${money(r.cost_per_serving)}/serving)</option>`).join('')}</select></label>
      <label>Servings <input name="servings" type="number" inputmode="decimal" min="0.25" step="0.25" value="1"></label>
      <button class="btn primary block">Add</button>
    </form>`);
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('plan.set', { date: f.date.value, slot: f.slot.value, recipe_id: f.recipe_id.value, servings: f.servings.value });
      closeSheet();
      if (location.hash === '#plan') renderPlan(); else { store.set('planWeek', iso(mondayOf(parseIso(f.date.value)))); location.hash = '#plan'; }
    } catch (er) { fail(er); }
  };
}

/* ================= BUDGET ================= */
async function renderBudget(mode = 'money') {
  const again = () => renderBudget(mode);
  const day = store.get('budgetDate', null);
  const b = await api('budget.get', day ? { date: day } : {});
  S.aisles = b.aisle_order || [];
  const per = b.period;
  const isCurrent = per.current;
  if (isCurrent) { S.spent = b.spent; S.budget = b.budget; S.period = per; updatePill(); }
  const left = b.budget - b.spent;
  const daysLeft = per.days_left;
  const monthLabel = per.label;
  const dayShift = (d, n) => { const x = parseIso(d); x.setDate(x.getDate() + n); return iso(x); };

  view.innerHTML = mode === 'me' ? `
    <section class="card me-card">
      <div class="avatar" aria-hidden="true">${esc(((S.user.display_name || S.user.username || '?').trim()[0] || '?').toUpperCase())}</div>
      <div class="grow"><b>${esc(S.user.display_name)}</b><div class="small muted">@${esc(S.user.username)}${S.household ? ` · ${esc(S.household.name)}` : ''}</div></div>
      <button class="btn small" data-act="rename">Edit name</button>
    </section>

    <section class="card stack">
      <h2>Daily targets</h2>
      <form class="stack" id="targets">
        <div class="grid2">
          <label>Protein (g) <input name="protein" type="number" inputmode="numeric" min="0" step="1" value="${(S.users.find((u) => u.id === S.user.id) || {}).protein_target_g ?? ''}"></label>
          <label>Energy (kJ) <input name="kj" type="number" inputmode="numeric" min="0" step="1" value="${(S.users.find((u) => u.id === S.user.id) || {}).kj_target ?? ''}"></label>
        </div>
        <button class="btn">Save targets</button></form>
    </section>

    <section class="card stack">
      <h2>Money</h2>
      <form class="row" id="budgetForm"><label class="grow">Monthly grocery budget (R) <input name="monthly_budget" type="number" inputmode="decimal" step="0.01" min="0" value="${b.budget}"></label><button class="btn">Save</button></form>
      <form class="row" id="paydayForm"><label class="grow">Payday (day of the month) <input name="payday" type="number" inputmode="numeric" min="1" max="31" step="1" value="${b.payday || 1}"></label><button class="btn">Save</button></form>
      <p class="small muted">When payday falls on a weekend or public holiday, the pay month starts on the working day before, the way salaries are paid.</p>
      <form class="row" id="taWeekly"><label class="grow">Weekly takeaway allowance (R) <input name="weekly" type="number" inputmode="decimal" step="0.01" min="0" value="${b.takeaway_weekly}"></label><button class="btn">Save</button></form>
    </section>

    <section class="card stack">
      <h2>Household</h2>
      <button class="btn block" data-act="household">${S.household ? `${esc(S.household.name)} · ${S.household.mode === 'shared' ? 'shared kitchen' : 'separate kitchens'} · ${S.household.members.length} ${S.household.members.length === 1 ? 'person' : 'people'}` : 'Start a household or invite someone'}</button>
    </section>

    <section class="card stack">
      <h2>Shopping</h2>
      <div class="small muted">Your shops</div>
      <ul class="list">${S.stores.map((s) => `<li class="shop-row"><span class="grow">${esc(s.name)}</span><button class="btn small" data-rename="${s.id}">Rename</button><button class="icon-btn" data-del-store="${s.id}" aria-label="Delete">✕</button></li>`).join('')}</ul>
      <form class="row" id="storeForm"><input name="name" class="grow" placeholder="Add a shop"><button class="btn">Add</button></form>

      <div class="stack tight"><span class="small muted">Aisle order (how the shopping list is grouped)</span>
        <ul class="list card flush" id="aisleEd">${(S.aisles || []).map((a, i) => `<li><span class="grow">${esc(a)}</span><button type="button" class="icon-btn" data-aisle-up="${i}" aria-label="Move ${esc(a)} up" ${i ? '' : 'disabled'}>↑</button><button type="button" class="icon-btn" data-aisle-del="${i}" aria-label="Remove ${esc(a)}">✕</button></li>`).join('')}</ul>
        <form class="row" id="aisleAdd"><input name="aisle" class="grow" placeholder="Add an aisle"><button class="btn">Add</button></form>
      </div>
      ${S.offReady ? `<div class="toggle-row static"><span class="grow"><b>Share products I add with Open Food Facts</b><span class="small muted block">Only product facts and label photos, so the next person's scan works. Never your name, prices or lists.</span></span>
        <button type="button" class="switch ${S.offShare === '1' ? 'on' : ''}" data-act="off-share" aria-pressed="${S.offShare === '1'}" aria-label="Share products with Open Food Facts"><i></i></button></div>` : ''}
    </section>

    <button class="btn block" data-act="feedback">Tell us what to fix or add</button>

    <section class="card stack">
      <h2>Account and data</h2>
      <div class="row"><button class="btn small grow" data-act="password">Change password</button><button class="btn small grow" data-act="logout">Log out</button></div>
      <div class="row"><button class="btn small grow" data-act="export">Download my data</button><a class="btn small grow" href="./?privacy">How your data is kept</a></div>
      <button class="btn small danger block" data-act="delete-account">Delete my account</button>
    </section>
    ${S.isAdmin ? '<section class="card stack"><h2>Running the app</h2><div class="row"><button class="btn grow" data-act="admin">People</button><button class="btn grow" data-act="pilot">Pilot numbers</button></div><button class="btn block" data-act="off-import">Load South African products</button><p class="small muted" id="importStatus">From Open Food Facts into the shared catalogue, 100 at a time. Keep this screen open; it takes a while.</p></section>' : ''}
    <p class="small muted" id="dispCheck"></p>
    <p class="small muted">Product names and nutrition partly come from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a>, shared under the <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">Open Database Licence</a>.</p>
` : `
    <div class="row">
      <button class="btn small" data-day="${dayShift(per.start, -1)}" aria-label="Previous pay month">‹</button>
      <button class="btn small grow" data-day="">${esc(monthLabel)}</button>
      <button class="btn small" data-day="${dayShift(per.end, 1)}" aria-label="Next pay month">›</button>
    </div>
    <section class="card stack">
      <div class="grid3 right">
        <div><div class="small muted">Budget</div><b class="num">${money(b.budget)}</b></div>
        <div><div class="small muted">Spent</div><b class="num">${money(b.spent)}</b></div>
        <div><div class="small muted">Left</div><b class="num ${left < 0 ? 'bad-text' : 'good-text'}">${money(left)}</b></div>
      </div>
      <div class="meter ${left < 0 ? 'bad' : left < b.budget * 0.2 ? 'warn' : ''}"><div id="bMeter"></div></div>
      ${isCurrent && left > 0 ? `<p class="small muted">${daysLeft} day${daysLeft === 1 ? '' : 's'} to payday, so about ${money(left / daysLeft)} a day or ${money((left / daysLeft) * 7)} a week.</p>` : ''}
      ${left < 0 ? `<p class="small bad-text">Over budget by ${money(-left)}.</p>` : ''}
      ${S.household && S.household.mode === 'shared' ? `<p class="small muted">Shared kitchen: ${esc(S.household.members.map((m) => m.display_name).join(', '))} shop from this budget. Takeaways below are yours alone.</p>` : ''}
    </section>

    <section class="card stack">
      <div class="row between"><h2>Takeaways</h2><button class="btn small" data-act="log-ta">＋ Log</button></div>
      <div class="grid2 right">
        <div><div class="small muted">This pay month</div><b class="num ${b.eating_out > b.takeaway_weekly * 52 / 12 ? 'bad-text' : ''}">${money(b.eating_out)}</b></div>
        <div><div class="small muted">Allowance a month</div><b class="num">${money(b.takeaway_weekly * 52 / 12)}</b></div>
      </div>
      <p class="small muted">Kept separate from groceries, so the grocery budget stays honest.</p>
    </section>

    <section class="card flush">
      <div class="section-head"><h2 class="grow">Shops this pay month</h2><button class="btn small" data-act="add-trip">＋ Log spend</button></div>
      <ul class="list">${b.trips.map((t) => `<li><div class="grow"><div class="name">${esc(t.store || (t.kind === 'eating_out' ? (t.note || 'Takeaway') : 'Other'))}${t.kind === 'eating_out' ? '<span class="tag warn">takeaway</span>' : ''}</div>
        <div class="sub">${esc(t.trip_date)}${t.who ? ` · ${esc(t.who)}` : ''}${t.note && t.kind !== 'eating_out' ? ` · ${esc(t.note)}` : ''}${t.estimate !== null && t.estimate !== undefined && t.estimate > 0 ? ` · <span class="${Math.abs(t.total - t.estimate) / t.estimate > 0.05 ? 'warn-text' : 'good-text'}">est. ${money(t.estimate)}</span>` : ''}</div></div>
        <b class="num">${money(t.total)}</b><button class="icon-btn" data-del-trip="${t.id}" aria-label="Delete">✕</button></li>`).join('') || '<li class="empty">No shops logged yet.</li>'}</ul>
    </section>

    <a class="small muted settings-link" href="#me">Budget, payday and takeaway allowance are under Me ›</a>
`;
  const meter = document.getElementById('bMeter');
  if (meter) meter.style.width = `${Math.min(100, b.budget > 0 ? (b.spent / b.budget) * 100 : 100)}%`;

  const dc = document.getElementById('dispCheck');
  if (dc) dc.textContent = displayCheck();
  const refreshStores = async () => { S.stores = (await api('bootstrap')).stores; };

  view.onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'budgetForm') { await api('budget.set', { monthly_budget: e.target.monthly_budget.value }); S.budget = Number(e.target.monthly_budget.value); toast('Budget saved'); }
      if (e.target.id === 'paydayForm') { const r = await api('budget.set', { payday: e.target.payday.value }); S.period = r.period; store.set('budgetDate', null); toast(`Pay month now ${r.period.label}`); }
      if (e.target.id === 'targets') {
        await api('account.targets', { protein_target_g: e.target.protein.value, kj_target: e.target.kj.value });
        S.users = (await api('bootstrap')).users;
        toast('Targets saved');
      }
      if (e.target.id === 'aisleAdd' && e.target.aisle.value.trim()) {
        S.aisles = (await api('aisles.set', { order: [...S.aisles, e.target.aisle.value.trim()] })).aisle_order;
      }
      if (e.target.id === 'taWeekly') { await api('takeaway.set', { weekly: e.target.weekly.value }); toast('Takeaway allowance saved'); }
      if (e.target.id === 'storeForm') { await api('stores.add', { name: e.target.name.value }); await refreshStores(); }
      again();
    } catch (er) { fail(er); }
  };
  view.onclick = async (e) => {
    const t = e.target.closest('[data-day],[data-act],[data-del-trip],[data-del-store],[data-rename],[data-aisle-up],[data-aisle-del]');
    if (!t) return;
    try {
      if (t.dataset.aisleUp || t.dataset.aisleDel) {
        const order = [...S.aisles];
        if (t.dataset.aisleUp) { const i = Number(t.dataset.aisleUp); [order[i - 1], order[i]] = [order[i], order[i - 1]]; }
        else order.splice(Number(t.dataset.aisleDel), 1);
        S.aisles = (await api('aisles.set', { order })).aisle_order;
        return again();
      }
      if (t.dataset.day !== undefined) { store.set('budgetDate', t.dataset.day || null); return again(); }
      if (t.dataset.delTrip) { if (!confirm('Delete this logged shop?')) return; await api('trips.delete', { id: t.dataset.delTrip }); return again(); }
      if (t.dataset.delStore) {
        if (!confirm(`Delete ${storeName(t.dataset.delStore)}? All its saved prices go too.`)) return;
        await api('stores.delete', { id: t.dataset.delStore }); await refreshStores();
        if (String(S.storeId) === String(t.dataset.delStore)) S.storeId = S.stores[0] ? String(S.stores[0].id) : null;
        return again();
      }
      if (t.dataset.rename) {
        const name = prompt('New name', storeName(t.dataset.rename));
        if (!name) return;
        await api('stores.rename', { id: t.dataset.rename, name }); await refreshStores(); return again();
      }
      if (t.dataset.act === 'add-trip') return tripSheet();
      if (t.dataset.act === 'log-ta') return takeawaySheet(() => again());
      if (t.dataset.act === 'admin') return adminSheet();
      if (t.dataset.act === 'rename') {
        const name = prompt('What should the app call you?', S.user.display_name || '');
        if (name && name.trim()) { await api('account.name', { display_name: name.trim() }); S.user.display_name = name.trim(); toast('Name saved'); }
        return;
      }
      if (t.dataset.act === 'household') return householdSheet();
      if (t.dataset.act === 'feedback') return feedbackSheet();
      if (t.dataset.act === 'pilot') return pilotSheet();
      if (t.dataset.act === 'off-import') {
        // one page every 7 seconds: Open Food Facts allows 10 searches a minute
        const st = document.getElementById('importStatus');
        t.disabled = true;
        let added = 0;
        let tries = 0;
        const WAITS = [30, 60, 120, 180, 300];   // seconds to wait after each busy answer in a row
        const sleep = (sec) => new Promise((res) => setTimeout(res, sec * 1000));
        for (;;) {
          if (location.hash !== '#me') { toast('Loading paused. Tap the button again to carry on.'); break; }
          let r;
          try {
            r = await post('admin.off_import', {}, 60000);   // their searches can take 30 s or more
            tries = 0;
          } catch (er) {
            const busy = er.offline || er.status === 503 || er.status === 502 || er.status === 504;
            if (!busy || tries >= WAITS.length) { st.textContent = `Stopped: ${er.message || 'no answer'}. Tap the button to carry on from the same page.`; break; }
            const wait = WAITS[tries++];
            for (let left = wait; left > 0 && location.hash === '#me'; left -= 5) {
              st.textContent = `${er.message || 'No answer from Open Food Facts'}. Trying again in ${left} s (try ${tries} of ${WAITS.length}). ${added} new products so far.`;
              await sleep(Math.min(5, left));
            }
            continue;
          }
          added += r.added;
          st.textContent = `Page ${r.page} of ${r.pages}: ${added} new products so far, ${r.catalogue} in the catalogue.`;
          if (r.done) { st.textContent += ' Done.'; toast('South African products loaded'); break; }
          await new Promise((res) => setTimeout(res, 7000));
        }
        t.disabled = false;
        return;
      }
      if (t.dataset.act === 'off-share') {
        const r = await api('off.consent', { share: S.offShare !== '1' });
        S.offShare = r.off_share;
        t.classList.toggle('on', S.offShare === '1'); t.setAttribute('aria-pressed', String(S.offShare === '1'));
        return toast(S.offShare === '1' ? 'New products you add will be shared' : 'Sharing off');
      }
      if (t.dataset.act === 'export') {
        const { export: data } = await api('account.export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `kitchen-budget-${S.user.username}-${iso(new Date())}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        return toast('Downloaded');
      }
      if (t.dataset.act === 'delete-account') {
        const pw = prompt('This deletes your account, list, plan, budget, shops, prices and private recipes for good. Type your password to confirm.');
        if (!pw) return;
        await api('account.delete', { password: pw });
        Object.keys(localStorage).filter((k) => k.startsWith('kb:')).forEach((k) => localStorage.removeItem(k));
        location.href = './';
        return;
      }
      if (t.dataset.act === 'logout') {
        if (queue.length && !confirm(`${queue.length} change${queue.length === 1 ? " hasn't" : "s haven't"} synced yet and will be lost. Log out anyway?`)) return;
        await api('logout');
        // forget the offline copy of everything on this phone
        Object.keys(localStorage).filter((k) => k.startsWith('kb:')).forEach((k) => localStorage.removeItem(k));
        navigator.serviceWorker?.controller?.postMessage({ type: 'clear' });
        location.reload();
      }
      if (t.dataset.act === 'password') return passwordSheet();
    } catch (er) { fail(er); }
  };
}

function tripSheet() {
  openSheet(`${sheetHead('Log spend')}
    <form class="stack">
      <p class="muted small">For shopping you didn't do from the list.</p>
      <label>Shop ${storeSelect('tStore', S.storeId, true)}</label>
      <label>Amount (R) <input name="total" type="number" inputmode="decimal" step="0.01" min="0" required></label>
      <label>Date <input name="date" type="date" value="${iso(new Date())}"></label>
      <label>Note <input name="note" placeholder="Bread & milk"></label>
      <button class="btn primary block">Save</button>
    </form>`);
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('trips.add', { store_id: document.getElementById('tStore').value || null, total: f.total.value, date: f.date.value, note: f.note.value });
      closeSheet(); route({ keep: true });
    } catch (er) { fail(er); }
  };
}

function passwordSheet() {
  openSheet(`${sheetHead('Change password')}
    <form class="stack">
      <label>Current password <input name="current" type="password" autocomplete="current-password" required></label>
      <label>New password <input name="new" type="password" autocomplete="new-password" minlength="8" required></label>
      <button class="btn primary block">Change</button>
    </form>`);
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('account.password', { current: e.target.current.value, new: e.target.new.value }); closeSheet(); toast('Password changed'); } catch (er) { fail(er); }
  };
}

/** First screen for someone who just signed up: the three numbers that make the app useful. */
function welcomeSheet() {
  openSheet(`${sheetHead(`Welcome, ${S.user.display_name}`)}
    <p>Three quick things and the app starts working for you. You can change them any time under Me: tap your initial at the top.</p>
    <form class="stack" id="wlForm">
      <label>Monthly grocery budget (R) <input name="budget" type="number" inputmode="decimal" min="0" step="1" placeholder="2500"></label>
      <label>Payday (day of the month) <input name="payday" type="number" inputmode="numeric" min="1" max="31" step="1" value="25"></label>
      <label>Daily protein target in grams (optional) <input name="protein" type="number" inputmode="numeric" min="0" step="1" placeholder="120"></label>
      <button class="btn primary block">Let's go</button>
    </form>
    <div class="stack tight small muted">
      <span><b>Then:</b> scan or add the things you buy, so the app learns your prices.</span>
      <span>Add a recipe you cook (or copy a shared one), plan your week and tap “Put the week on my list”.</span>
      <span>Your list, plan and budget are yours alone. <a href="./?privacy">How your data is kept</a></span>
    </div>`);
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const data = {};
      if (f.budget.value) data.monthly_budget = f.budget.value;
      if (f.payday.value) data.payday = f.payday.value;
      if (Object.keys(data).length) { const r = await api('budget.set', data); S.period = r.period; if (data.monthly_budget) S.budget = Number(data.monthly_budget); }
      if (f.protein.value) await api('account.targets', { protein_target_g: f.protein.value });
      closeSheet(); updatePill(); route();
      toast('All set');
    } catch (er) { fail(er); }
  };
}

/** Admin: who's using the app, reset links, switch accounts off, open or close sign-ups. */
async function adminSheet() {
  let offStats = null;
  const draw = (users, open) => {
    const ago = (d) => {
      if (!d) return 'never';
      const days = Math.floor((Date.now() - new Date(d.replace(' ', 'T')).getTime()) / 86400000);
      return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    };
    openSheet(`${sheetHead('People using the app')}
      <div class="toggle-row static"><span class="grow"><b>New people can sign up</b><span class="small muted block">${open ? 'Anyone with the link can make an account.' : 'Sign-ups are closed. Existing people can still log in.'}</span></span>
        <button type="button" class="switch ${open ? 'on' : ''}" data-act="signups" aria-pressed="${open}" aria-label="Allow sign-ups"><i></i></button></div>
      <ul class="list card flush">${users.map((u) => `<li data-id="${u.id}" class="admin-user">
        <div class="grow"><div class="name">${esc(u.display_name)} <span class="muted small">@${esc(u.username)}</span>${Number(u.is_admin) ? ' <span class="tag">admin</span>' : ''}${Number(u.disabled) ? ' <span class="tag warn">switched off</span>' : ''}</div>
          <div class="sub">joined ${esc(String(u.created_at).slice(0, 10))} · last used ${ago(u.last_seen)} · ${u.recipes} recipe${Number(u.recipes) === 1 ? '' : 's'} · ${u.trips} shops logged</div>
          ${u.id === S.user.id ? '' : `<div class="row wrap gap admin-actions">
            <button type="button" class="btn small" data-act="reset">Password reset link</button>
            <button type="button" class="btn small" data-act="toggle">${Number(u.disabled) ? 'Switch on' : 'Switch off'}</button>
            <button type="button" class="btn small ghost" data-act="mkadmin">${Number(u.is_admin) ? 'Remove admin' : 'Make admin'}</button></div>`}
        </div></li>`).join('')}</ul>
      <p class="small muted">A reset link works once, for 24 hours. Send it to them yourself, e.g. on WhatsApp.</p>
      ${offStats ? `<p class="small muted">Open Food Facts: ${Number(offStats.sent || 0)} products added, ${Number(offStats.pending || 0)} waiting, ${Number(offStats.exists || 0)} already there${offStats.failed ? `, <span class="warn-text">${Number(offStats.failed)} failed</span>` : ''}.</p>` : ''}`);
    sheetBody.onclick = async (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const li = t.closest('li');
      const u = li ? users.find((x) => x.id === Number(li.dataset.id)) : null;
      try {
        if (t.dataset.act === 'signups') { const r = await api('admin.signups', { open: !open }); return draw(users, r.signups_open); }
        if (t.dataset.act === 'reset') {
          const { token } = await api('admin.reset', { user_id: u.id });
          const link = `${location.origin}${location.pathname}?reset=${token}`;
          if (navigator.share) { try { await navigator.share({ title: 'Kitchen Budget password reset', text: `Set a new Kitchen Budget password (link works once, for 24 hours): ${link}` }); return; } catch { /* fall back to copying */ } }
          try { await navigator.clipboard.writeText(link); toast(`Reset link for ${u.display_name} copied. Send it to them`); } catch { prompt('Copy this link and send it:', link); }
          return;
        }
        if (t.dataset.act === 'toggle') {
          if (!Number(u.disabled) && !confirm(`Switch off ${u.display_name}'s account? They can't log in until you switch it back on. Nothing is deleted.`)) return;
          await api('admin.disable', { user_id: u.id, disabled: !Number(u.disabled) });
        }
        if (t.dataset.act === 'mkadmin') await api('admin.admin', { user_id: u.id, admin: !Number(u.is_admin) });
        const r = await api('admin.users');
        offStats = r.off;
        draw(r.users.map((x) => ({ ...x, id: Number(x.id) })), r.signups_open);
      } catch (er) { fail(er); }
    };
  };
  const r = await api('admin.users');
  offStats = r.off;
  draw(r.users.map((x) => ({ ...x, id: Number(x.id) })), r.signups_open);
}

/* ---------- feedback and pilot numbers ---------- */
function feedbackSheet() {
  openSheet(`${sheetHead('Tell us what to fix or add')}
    <form class="stack" id="fbForm">
      <label>What's on your mind? <textarea name="note" rows="5" maxlength="2000" required placeholder="Something annoying, broken, missing, or something you love"></textarea></label>
      <button class="btn primary block">Send</button>
      <p class="small muted">It goes to the person who runs the app, with your name.</p>
    </form>`);
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('feedback.send', { kind: 'note', note: e.target.note.value.trim() }); closeSheet(); toast('Thank you, sent'); } catch (er) { fail(er); }
  };
}

/** A week (and four weeks) after joining: three quick questions, asked once. */
function checkinSheet(kind) {
  let answered = false;
  openSheet(`${sheetHead(kind === 'week4' ? 'A month in: how is it going?' : 'One week in: how is it going?')}
    <form class="stack" id="ciForm">
      <label>What did you use the most? <textarea name="used" rows="2" maxlength="2000"></textarea></label>
      <label>What annoyed you or got in the way? <textarea name="annoyed" rows="2" maxlength="2000"></textarea></label>
      <label>What's missing? <textarea name="missing" rows="2" maxlength="2000"></textarea></label>
      <button class="btn primary block">Send</button>
      <button type="button" class="btn block" data-act="skip">Not now</button>
      <p class="small muted">Answer one or all three. It goes to the person who runs the app, with your name.</p>
    </form>`, async () => { if (!answered) { S.checkin = null; try { await api('feedback.skip', { kind }); } catch { /* ask again next time */ } } });
  sheetBody.onclick = (e) => { if (e.target.closest('[data-act=skip]')) closeSheet(); };
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('feedback.send', { kind, used: f.used.value.trim(), annoyed: f.annoyed.value.trim(), missing: f.missing.value.trim() });
      answered = true; S.checkin = null;
      closeSheet(); toast('Thank you, that really helps');
    } catch (er) { fail(er); }
  };
}

/** Admin: the numbers behind the lab's exit criteria. */
async function pilotSheet() {
  let r;
  try { r = await api('admin.pilot'); } catch (er) { return fail(er); }
  const wk = (d) => new Date(`${d}T00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  const max = Math.max(1, ...r.weeks.map((w) => w.active));
  openSheet(`${sheetHead('Pilot numbers')}
    <div class="grid3 right">
      <div><div class="small muted">People</div><b class="num">${r.people}</b></div>
      <div><div class="small muted">New this week</div><b class="num">${r.joined_this_week}</b></div>
      <div><div class="small muted">Households</div><b class="num">${r.households}</b><div class="small muted">${r.shared_kitchens} shared</div></div>
    </div>
    <div class="stack tight"><span class="small muted">Exit criteria for the web app</span>
      <ul class="list card flush">${r.exit.map((x) => `<li><span class="grow"><b>${esc(x.label)}</b><span class="small muted block">${esc(x.bar)} · now: ${esc(x.value)}</span></span><span class="tag ${x.met ? '' : 'warn'}">${x.met ? 'met' : 'not yet'}</span></li>`).join('')}</ul>
    </div>
    <div class="stack tight"><span class="small muted">The last 8 weeks (week starting)</span>
      <table class="pilot-table"><thead><tr><th>Week</th><th>Active</th><th>Shops</th><th>Takeaways /person</th><th>Not on OFF</th></tr></thead>
      <tbody>${r.weeks.map((w) => `<tr><td>${wk(w.week)}</td><td><span class="bar-cell"><i class="pbar w${Math.round((w.active / max) * 10)}"></i>${w.active}</span></td><td>${w.shops}</td><td>${money(w.takeaway_per_person)}</td><td>${w.off_asked ? `${w.off_missing} of ${w.off_asked}` : '–'}</td></tr>`).join('')}</tbody></table>
      <p class="small muted">"Not on OFF": new barcodes scanned that Open Food Facts didn't have. Label reads this month: ${r.label_reads_month}. Recipes: ${r.recipes}.</p>
    </div>
    <div class="stack tight"><span class="small muted">What people said</span>
      ${r.feedback.length ? `<ul class="list card flush">${r.feedback.map((f) => `<li class="fb-item"><span class="small muted">${esc(f.who || 'Someone')} · ${esc(String(f.created_at).slice(0, 10))}${f.kind !== 'note' ? ` · ${f.kind === 'week1' ? 'week 1' : 'week 4'} check-in` : ''}</span>
        ${f.used ? `<span><b>Used:</b> ${esc(f.used)}</span>` : ''}${f.annoyed ? `<span><b>Annoyed:</b> ${esc(f.annoyed)}</span>` : ''}${f.missing ? `<span><b>Missing:</b> ${esc(f.missing)}</span>` : ''}${f.note ? `<span>${esc(f.note)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="small muted">Nothing yet. The week-1 check-in asks everyone automatically.</p>'}
    </div>`);
}

/* ---------- households ---------- */
const unsynced = () => (queue.length ? `${queue.length} change${queue.length === 1 ? " hasn't" : "s haven't"} synced yet. Wait for signal so they sync first.` : '');

/** After a household change you may be in a different kitchen: forget this phone's offline copy and start fresh. */
function reloadKitchen(msg) {
  Object.keys(localStorage).filter((k) => k.startsWith('kb:') && k !== 'kb:queue').forEach((k) => localStorage.removeItem(k));
  store.set('store', null);
  store.set('budgetDate', null);
  if (msg) store.set('flash', msg);
  history.replaceState(null, '', '#today');
  location.reload();
}

async function householdSheet() {
  let h = S.household;
  try { h = (await api('household.get')).household; S.household = h; } catch { /* offline: show what we know */ }
  if (!h) {
    openSheet(`${sheetHead('Household')}
      <p>Live with someone? Start a household and invite them. You'll see each other's recipes, and you can choose to share one kitchen: one list, pantry, meal plan, fridge and grocery budget.</p>
      <form class="stack" id="hhNew"><label>Household name <input name="name" required maxlength="60" placeholder="e.g. Our flat"></label><button class="btn primary block">Start a household</button></form>
      <p class="small muted">Got an invite link? Open it on this phone and you'll be asked to join.</p>`);
    sheetBody.onsubmit = async (e) => {
      e.preventDefault();
      try { S.household = (await api('household.create', { name: e.target.name.value.trim() })).household; toast('Household started. Now invite someone'); householdSheet(); } catch (er) { fail(er); }
    };
    return;
  }
  const owner = h.role === 'owner';
  const shared = h.mode === 'shared';
  const alone = h.members.length === 1;
  openSheet(`${sheetHead(h.name)}
    <div class="stack tight"><span class="small muted">Kitchen</span>
      <div class="seg" role="group" aria-label="How the household runs its kitchen">
        <button type="button" data-mode="separate" aria-pressed="${!shared}" class="${!shared ? 'on' : ''}">Separate</button>
        <button type="button" data-mode="shared" aria-pressed="${shared}" class="${shared ? 'on' : ''}">Shared kitchen</button>
      </div>
      <p class="small muted">${shared
        ? 'One shopping list, pantry, set of shops and prices, meal plan, fridge and grocery budget for everyone here. Takeaways, ingredient alerts and targets stay your own.'
        : "Everyone keeps their own list, plan and budget. You see each other's recipes; only the person who added a recipe can change it."}</p>
    </div>
    <div class="stack tight"><span class="small muted">People</span>
      <ul class="list card flush">${h.members.map((m) => `<li data-id="${m.id}"><span class="grow">${esc(m.display_name)}${m.id === S.user.id ? ' <span class="muted small">(you)</span>' : ''}${m.role === 'owner' ? ' <span class="tag">runs it</span>' : ''}</span>${owner && m.id !== S.user.id ? '<button type="button" class="btn small ghost" data-act="remove">Remove</button>' : ''}</li>`).join('')}</ul>
      <button type="button" class="btn primary block" data-act="invite">Invite someone</button>
      <p class="small muted">An invite link works once, for 7 days. Send it on WhatsApp; they can sign up from it.</p>
    </div>
    <div class="row"><button type="button" class="btn small grow" data-act="rename">Rename</button><button type="button" class="btn small grow danger" data-act="leave">Leave household</button></div>`);
  sheetBody.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-mode]');
    if (!t) return;
    try {
      if (t.dataset.mode) {
        const mode = t.dataset.mode;
        if (mode === h.mode) return;
        if (unsynced()) return toast(unsynced());
        const ok = confirm(mode === 'shared'
          ? `Share one kitchen with everyone in ${h.name}?\n\nThe first time a household shares, its kitchen starts as a copy of yours: shops and prices, pantry, list, plan from today, fridge, budget and payday. Your own kitchen is kept, and comes back if you switch to Separate or leave.`
          : 'Go back to separate kitchens?\n\nEveryone returns to their own list, plan and budget. The shared kitchen is kept in case you switch back.');
        if (!ok) return;
        await api('household.mode', { mode });
        return reloadKitchen(mode === 'shared' ? 'Kitchen shared' : 'Back to your own kitchen');
      }
      if (t.dataset.act === 'invite') {
        const { token } = await api('household.invite');
        const link = `${location.origin}${location.pathname}?join=${token}`;
        const text = `Join ${h.name} on Kitchen Budget (the link works once, for 7 days): ${link}`;
        if (navigator.share) { try { await navigator.share({ title: 'Kitchen Budget invite', text }); return; } catch { /* cancelled or not allowed: copy instead */ } }
        try { await navigator.clipboard.writeText(link); toast('Invite link copied. Send it to them'); } catch { prompt('Copy this link and send it:', link); }
        return;
      }
      if (t.dataset.act === 'rename') {
        const name = prompt('Household name', h.name);
        if (name && name.trim()) { S.household = (await api('household.rename', { name: name.trim() })).household; householdSheet(); }
        return;
      }
      if (t.dataset.act === 'remove') {
        const m = h.members.find((x) => x.id === Number(t.closest('li').dataset.id));
        if (!confirm(`Remove ${m.display_name} from ${h.name}? They go back to their own kitchen. What they added to a shared kitchen stays here.`)) return;
        S.household = (await api('household.remove', { user_id: m.id })).household;
        return householdSheet();
      }
      if (t.dataset.act === 'leave') {
        if (shared && unsynced()) return toast(unsynced());
        const ok = confirm(alone
          ? `You're the only one in ${h.name}. Leaving closes it${shared ? ', and deletes its shared kitchen (list, plan, budget and shops logged there)' : ''}. Your own kitchen is kept.`
          : `Leave ${h.name}?${shared ? ' You go back to your own kitchen; what you added to the shared one stays with the household.' : ''} Your recipes leave with you.`);
        if (!ok) return;
        await api('household.leave');
        return reloadKitchen(`You left ${h.name}`);
      }
    } catch (er) { fail(er); }
  };
}

/** Opened from an invite link (?join=…), after logging in or signing up. */
async function joinSheet(token, isNew) {
  let p;
  try { p = await api('household.preview', { token }); } catch (er) { fail(er); if (isNew) welcomeSheet(); return; }
  if (p.same) { toast(`You're already in ${p.household}`); return; }
  let joined = false;
  openSheet(`${sheetHead('Join a household')}
    <p><b>${esc(p.inviter || 'Someone')}</b> invited you to join <b>${esc(p.household)}</b> (${p.members} ${p.members === 1 ? 'person' : 'people'} so far).</p>
    <p class="small muted">You'll see each other's recipes. If the household shares its kitchen, you'll use its list, plan and budget; your own are kept in case you leave.</p>
    ${p.already ? "<p class=\"error\">You're already in a household. Leave it under Me → Household first, then open the link again.</p>" : '<button type="button" class="btn primary block" data-act="join">Join</button>'}
    <button type="button" class="btn block" data-close>Not now</button>`, () => { if (isNew && !joined) welcomeSheet(); });
  sheetBody.onclick = async (e) => {
    if (!e.target.closest('[data-act=join]')) return;
    try {
      const { household } = await api('household.join', { token });
      joined = true;
      if (household.mode === 'shared') return reloadKitchen(`You joined ${household.name}`);
      S.household = household;
      closeSheet();
      toast(`You joined ${household.name}`);
      route();
      if (isNew) welcomeSheet();
    } catch (er) { fail(er); }
  };
}

/* ---------- start ---------- */
(async function init() {
  try {
    const b = await api('bootstrap');
    Object.assign(S, { user: b.user, users: b.users, stores: b.stores, budget: b.budget, spent: b.spent, month: b.month, labelReader: !!b.label_reader, 
      alerts: Array.isArray(b.alerts) ? {} : (b.alerts || {}), period: b.period, payday: b.payday, isAdmin: !!b.is_admin, signupsOpen: !!b.signups_open, household: b.household || null, offReady: !!b.off_ready, offShare: b.off_share || '', checkin: b.checkin || null });
    const saved = store.get('store', null);
    S.storeId = S.stores.some((s) => String(s.id) === String(saved)) ? String(saved) : (S.stores[0] ? String(S.stores[0].id) : null);
    store.set('budgetDate', null);
    updatePill();
    if (S.offReady && S.offShare === '1' && navigator.onLine) setTimeout(() => api('off.sync').catch(() => {}), 4000);   // anything left waiting
    const flash = store.get('flash', null);
    if (flash) { store.set('flash', null); setTimeout(() => toast(flash), 300); }
    if (location.hash === '#welcome') { history.replaceState(null, '', '#today'); route(); welcomeSheet(); return; }
    const join = location.hash.match(/^#join=([0-9a-f]{48})(&new)?$/);
    if (join) { history.replaceState(null, '', '#today'); route(); joinSheet(join[1], !!join[2]); return; }
    route();
    if (S.checkin) setTimeout(() => { if (sheet.hidden) checkinSheet(S.checkin); }, 2500);
  } catch (e) {
    view.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
})();
