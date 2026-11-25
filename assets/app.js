'use strict';

/* ---------- basics ---------- */
let CSRF = document.querySelector('meta[name=csrf]').content;
const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const titleEl = document.getElementById('title');
const pill = document.getElementById('budgetPill');

const S = { user: null, users: [], stores: [], budget: 0, spent: 0, month: '', products: [], storeId: null, aisles: [], pendingDel: new Set(), pendingClear: null };
const UNITS = ['each', 'g', 'kg', 'ml', 'l'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const NUTRIENTS = [
  ['energy_kj', 'Energy', 'kJ'], ['protein_g', 'Protein', 'g'], ['carbs_g', 'Carbs', 'g'], ['sugar_g', 'Sugar', 'g'],
  ['fat_g', 'Fat', 'g'], ['satfat_g', 'Sat. fat', 'g'], ['fibre_g', 'Fibre', 'g'], ['sodium_mg', 'Sodium', 'mg'],
];

const store = {
  get(k, d = null) { try { const v = localStorage.getItem('kb_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('kb_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* ================= DATA, OFFLINE AND SYNC =================
 * Reads (list, products, plan…) are kept in localStorage so the app still shows them with no signal.
 * Shopping-list changes made offline go into a queue, are applied to the saved copy straight away,
 * and are sent in order when the connection comes back. Each queued change has an op_id so the
 * server ignores it if it already arrived. */
const READS = new Set(['bootstrap', 'list.get', 'products.list', 'plan.get', 'recipes.list', 'fridge.list', 'budget.get', 'takeaway.get']);
const QUEUEABLE = new Set(['list.add', 'list.update', 'list.delete', 'list.clear', 'list.checkout', 'products.price']);
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
function undoable(msg, commit, undo, ms = 5000) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span> <button type="button" class="toast-btn">Undo</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  let done = false;
  const timer = setTimeout(async () => { done = true; t.hidden = true; try { await commit(); } catch (er) { fail(er); } }, ms);
  toastTimer = timer;
  t.querySelector('.toast-btn').onclick = () => { if (done) return; clearTimeout(timer); t.hidden = true; undo(); };
}

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
  if (storeId && p[storeId]) return { price: p[storeId].price, storeId: String(storeId), here: true };
  let best = null;
  for (const [sid, v] of Object.entries(p)) if (!best || v.price < best.price) best = { price: v.price, storeId: sid, here: false };
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
pill.addEventListener('click', () => { location.hash = '#budget'; });

/* ---------- routing ---------- */
const routes = { list: ['List', renderList], products: ['Products', renderProducts], plan: ['Meal plan', renderPlan], recipes: ['Recipes', renderRecipes], budget: ['Budget', renderBudget] };
async function route(opts) {
  const keep = !!(opts && opts.keep);   // refresh in place: no "Loading…" flash, keep the scroll position
  const key = (location.hash || '#list').slice(1).split('/')[0];
  const [title, fn] = routes[key] || routes.list;
  titleEl.textContent = title;
  document.body.className = `route-${routes[key] ? key : 'list'}`;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === key));
  view.onclick = view.oninput = view.onchange = view.onsubmit = null;
  const y = window.scrollY;
  if (!keep) view.innerHTML = '<p class="empty">Loading…</p>';
  try { await fn(); } catch (e) { view.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  if (keep) window.scrollTo(0, y);
}

/* ---------- keep the dock on the bottom edge ----------
 * iOS 26 home-screen apps can leave a band at the bottom as if Safari's toolbar were still there:
 * the window is shorter than the screen and fixed bars sit above that band. Measure the band and
 * push the bars down into it. While typing, the dock hides and the add bar sits on the keyboard. */
const isTyping = () => { const a = document.activeElement; return !!a && (['TEXTAREA', 'SELECT'].includes(a.tagName) || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(a.type))); };
function fitDock() {
  const typing = isTyping();
  document.body.classList.toggle('typing', typing);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let gap = 0;
  if (standalone && !typing) {
    const portrait = window.innerHeight >= window.innerWidth;
    const screenH = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
    gap = Math.round(screenH - window.innerHeight);
    if (gap < 2 || gap > 90) gap = 0;   // nothing to fix, or the keyboard/something else is up
  }
  document.documentElement.style.setProperty('--vp-gap', `${gap}px`);
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
  const [{ items, spent, budget, takeaway, fridge, today: todayMeals, last_shop: lastShop }] = await Promise.all([api('list.get'), S.products.length ? null : loadProducts()]);
  S.takeawayWeekly = takeaway.weekly;
  S.spent = spent; S.budget = budget; updatePill();

  S.lastListJson = JSON.stringify(items);
  S.listItems = items;
  const lines = items
    .filter((it) => !S.pendingDel.has(it.id) && !(S.pendingClear === 'all' || (S.pendingClear === 'checked' && it.checked)))
    .map((it) => ({ it, p: itemPrice(it) }));
  const open = lines.filter(({ it }) => !it.checked);
  const done = lines.filter(({ it }) => it.checked);
  const sum = (arr) => arr.reduce((s, { it, p }) => s + (p.price || 0) * it.qty, 0);
  const listTotal = sum(lines);
  const openTotal = sum(open);
  const checkedTotal = sum(done);
  const left = budget - spent;
  const after = left - listTotal;
  const monthName = new Date().toLocaleDateString('en-ZA', { month: 'long' });

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

  view.innerHTML = `
    ${budget > 0 ? '' : `<a class="banner" href="#budget"><b>Set your monthly grocery budget</b><span class="small">Budget tab → Settings. Then this shows what's left.</span></a>`}
    <section class="ring-card ${budget > 0 ? '' : 'hidden'}">
      ${ringSvg(spent, listTotal, budget)}
      <div class="ring-text">
        <span class="small muted">Left for ${esc(monthName)}</span>
        <span class="big">${money0(left)}</span>
        ${items.length ? `<span class="small ${after < 0 ? 'bad-text' : 'good-text'}">${after < 0 ? `${money0(-after)} over after this list` : `${money0(after)} after this list`}</span>` : `<span class="small muted">of ${money0(budget)} this month</span>`}
      </div>
    </section>

    ${homeCardsHtml(fridge, takeaway, lastShop)}
    ${todayHtml(todayMeals, fridge)}

    ${where ? whereToShopHtml(where) : `<div class="chips" role="group" aria-label="Shop you're in">
      ${compare.map((c) => {
        const detail = !c.count ? '' : c.known === c.count ? ` · <span class="num">${money0(c.total)}</span>` : ` <span class="sub">${c.known}/${c.count}</span>`;
        return `<button type="button" class="chip ${c.id === String(S.storeId) ? 'active' : ''}" data-store="${c.id}" aria-pressed="${c.id === String(S.storeId)}">${esc(c.name)}${detail}${c.id === cheapest ? ' <span class="best">✓</span>' : ''}</button>`;
      }).join('')}
    </div>`}

    <div class="heading-row"><h1>To buy <span class="muted">${open.length}</span></h1><span class="num strong">${money(openTotal)}</span></div>
    ${open.length ? aisleGroups(open).map(([cat, rows]) => `${cat !== null ? `<div class="aisle">${esc(cat)}</div>` : ''}<ul class="items">${rows.map(rowHtml).join('')}</ul>`).join('')
      : `<p class="empty">${done.length ? 'Everything is in the trolley.' : 'Nothing on the list. Add items below, or plan your week and tap “Put the week on my list”.'}</p>`}

    ${done.length ? `
      <div class="divider">In the trolley · ${money(checkedTotal)}</div>
      <ul class="items done">${done.map(rowHtml).join('')}</ul>
      <button class="btn primary block" data-act="checkout">Finish shop · ${money(checkedTotal)}</button>` : ''}

    ${items.length ? `<div class="row"><button class="btn small grow" data-act="clear-checked" ${done.length ? '' : 'disabled'}>Remove ticked</button><button class="btn small danger grow" data-act="clear-all">Clear list</button></div>` : ''}

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
      if (p.price === null) sub.push(`<span class="hint">Tap to add the ${esc(storeName(S.storeId))} price</span>`);
      else if (!p.here) sub.push(`<span class="hint">${esc(storeName(p.storeId))} price</span>`);
      else if (!p.manual) {
        const best = priceAt(it.prices, null);
        if (best.price !== null && best.price < p.price - 0.004) sub.push(`<span class="hint">${money(p.price - best.price)} cheaper at ${esc(storeName(best.storeId))}</span>`);
      }
    }
    const line = p.price === null ? null : p.price * it.qty;
    return `<li class="${p.price === null && !it.checked ? 'noprice' : ''}" data-id="${it.id}">
      <input type="checkbox" data-act="check" ${it.checked ? 'checked' : ''} aria-label="${esc(it.name)}">
      <div class="grow">
        <div class="name">${esc(it.name)}${it.from_plan && !it.checked ? '<span class="tag">plan</span>' : ''}</div>
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
    const matches = S.products.filter((p) => `${p.name} ${p.brand || ''}`.toLowerCase().includes(q)).slice(0, 6);
    sug.innerHTML = matches.map((p) => {
      const pr = priceAt(p.prices, S.storeId);
      return `<button data-pid="${p.id}"><span>${esc(p.name)} <span class="muted small">${esc(p.brand || '')} ${packLabel(p)}${p.pantry > 0 ? ` · ${fmtAmount(p.pantry, p.unit)} at home` : ''}</span></span><span class="num small">${money(pr.price)}</span></button>`;
    }).join('') + `<button data-new="1"><span>Add “${esc(input.value.trim())}” as a one-off</span><span class="muted">＋</span></button>`;
    sug.hidden = false;
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = sug.querySelector('button'); if (first) first.click(); }
    if (e.key === 'Escape') { sug.hidden = true; }
  };
  input.onblur = () => setTimeout(() => { sug.hidden = true; }, 200);
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
            S.pendingDel.add(it.id);
            renderList();
            undoable(`Removed ${it.name}`, async () => { await api('list.delete', { id: it.id }); S.pendingDel.delete(it.id); },
              () => { S.pendingDel.delete(it.id); renderList(); });
            return;
          }
          await api('list.update', { id: it.id, qty: it.qty - 1 });
          break;
        case 'price': {
          const p = itemPrice(it);
          const at = it.product_id ? ` at ${storeName(S.storeId)}` : '';
          const v = await askNumber(`Price of ${it.name}${at}`, p.here ? p.price : '', { hint: it.product_id ? 'Price for one pack. Saved to the product so the app learns it.' : 'Price for one.' });
          if (v === null) return;
          await api('list.update', { id: it.id, price: v, store_id: S.storeId });
          break;
        }
        case 'scan': return scanFlow('list');
        case 'usuals': return usualsSheet();
        case 'checkout': return checkoutSheet(checkedTotal);
        case 'clear-checked':
        case 'clear-all': {
          const all = el.dataset.act === 'clear-all';
          S.pendingClear = all ? 'all' : 'checked';
          renderList();
          undoable(all ? 'List cleared' : 'Ticked items removed',
            async () => { await api('list.clear', all ? { all: true } : {}); S.pendingClear = null; renderList(); },
            () => { S.pendingClear = null; renderList(); });
          return;
        }
        default: return;
      }
      renderList();
    } catch (er) { fail(er); }
  };
}

/* ---------- home: meals ready + takeaways ---------- */
function homeCardsHtml(fridge, takeaway, lastShop) {
  const portions = fridge.reduce((s, f) => s + f.portions, 0);
  const oldest = fridge.reduce((m, f) => (m && m.age_days >= f.age_days ? m : f), null);
  let fridgeNote = portions ? `${fridge.length} batch${fridge.length === 1 ? '' : 'es'}` : 'Cook something';
  let fridgeClass = 'muted';
  if (oldest && oldest.age_days >= 4) { fridgeNote = `${esc(oldest.name)}: ${oldest.age_days} days old`; fridgeClass = 'bad-text'; }
  else if (oldest && oldest.age_days >= 3) { fridgeNote = `Eat the ${esc(oldest.name)} first`; fridgeClass = 'warn-text'; }
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

const refreshHome = () => { if (location.hash === '' || location.hash === '#list') route(); };

function fridgeSheet() {
  const draw = (fridge) => {
    openSheet(`${sheetHead('Meals in the fridge')}
      ${fridge.length ? `<ul class="list card flush">${fridge.map((f) => {
        const ageCls = f.age_days >= 4 ? 'bad-text' : f.age_days >= 3 ? 'warn-text' : 'muted';
        const age = f.age_days === 0 ? 'cooked today' : f.age_days === 1 ? 'cooked yesterday' : `cooked ${f.age_days} days ago`;
        return `<li class="fridge-row" data-id="${f.id}">
          <div class="fr-top"><span class="name grow">${esc(f.name)}</span><span class="big-n num">${fmtQty(f.portions)}<span class="small muted"> left</span></span></div>
          <div class="fr-bottom">
            <span class="sub grow"><span class="${ageCls}">${age}</span>${f.grams_per_portion ? ` · ${f.grams_per_portion} g each` : ''}${f.cost_per_portion !== null ? ` · ${money(f.cost_per_portion)} each` : ''}</span>
            <button class="icon-btn" data-act="more" aria-label="Change or bin ${esc(f.name)}">⋯</button>
            <button class="btn small primary" data-act="eat">Ate one</button>
          </div></li>`;
      }).join('')}</ul>
      <p class="small muted">Cooked food keeps about 3–4 days in the fridge. Freeze what you won't get to.</p>` : '<p class="empty">Nothing cooked yet. Open a recipe and tap “Cooked it”, or finish cook mode.</p>'}
      <button class="btn block" data-act="add">＋ Add cooked food</button>`, refreshHome);
    sheetBody.onclick = async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const li = a.closest('li');
      const f = li ? fridge.find((x) => x.id === Number(li.dataset.id)) : null;
      try {
        if (a.dataset.act === 'eat') { draw((await api('fridge.eat', { id: f.id })).fridge); toast('Enjoy'); }
        if (a.dataset.act === 'more') {
          const v = await askNumber(`${f.name}: portions left`, f.portions, { hint: 'Set to 0 if it was eaten, frozen elsewhere or binned.', step: '1' });
          if (v === null) return fridgeSheet();
          draw((await api('fridge.set', { id: f.id, portions: v })).fridge);
        }
        if (a.dataset.act === 'add') addCookedSheet();
      } catch (er) { fail(er); }
    };
  };
  api('fridge.list').then((r) => draw(r.fridge)).catch(fail);
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
  const draw = (t, portions) => {
    const left = t.weekly - t.spent;
    openSheet(`${sheetHead('Log a takeaway')}
      <div class="row between"><span class="muted">Left this week</span><b class="num ${left < 0 ? 'bad-text' : 'good-text'}">${money(left)}</b></div>
      ${portions ? `<p class="small muted">You have ${fmtQty(portions)} meal${portions === 1 ? '' : 's'} ready in the fridge.</p>` : ''}
      <form class="stack" id="taForm">
        <label>Amount (R) <input name="total" type="number" inputmode="decimal" min="0" step="0.01" required></label>
        <label>Where / what <input name="note" placeholder="Nando's, pizza night…"></label>
        <label>Date <input name="date" type="date" value="${iso(new Date())}"></label>
        <button class="btn primary block">Log it</button>
      </form>
      ${t.items.length ? `<h3>This week</h3><ul class="list card flush">${t.items.map((i) => `<li><div class="grow"><div class="name">${esc(i.note || 'Takeaway')}</div><div class="sub">${esc(i.trip_date)}</div></div><b class="num">${money(i.total)}</b><button class="icon-btn" data-del="${i.id}" aria-label="Delete">✕</button></li>`).join('')}</ul>` : ''}
      <p class="small muted">Weekly allowance ${money0(t.weekly)}. Change it on the Budget tab.</p>`,
    onClose);
    setTimeout(() => { const i = sheetBody.querySelector('[name=total]'); if (i) i.focus(); }, 60);
    sheetBody.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await api('takeaway.add', { total: f.total.value, note: f.note.value, date: f.date.value });
        const l = r.takeaway.weekly - r.takeaway.spent;
        toast(l >= 0 ? `Logged. ${money0(l)} left this week` : `Logged. ${money0(-l)} over this week`);
        draw(r.takeaway, portions);
      } catch (er) { fail(er); }
    };
    sheetBody.onclick = async (e) => {
      const d = e.target.closest('[data-del]');
      if (!d || !confirm('Delete this takeaway?')) return;
      try { await api('trips.delete', { id: d.dataset.del }); draw((await api('takeaway.get')).takeaway, portions); } catch (er) { fail(er); }
    };
  };
  Promise.all([api('takeaway.get'), api('fridge.list')])
    .then(([t, f]) => draw(t.takeaway, f.fridge.reduce((s, x) => s + x.portions, 0)))
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
    const onList = location.hash === '' || location.hash === '#list';
    if (!onList) { clearInterval(listPoll); return; }
    if (!sheet.hidden || document.visibilityState !== 'visible' || ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement || {}).tagName)) return;
    if (S.pendingDel.size || S.pendingClear) return;
    try {
      const r = await api('list.get');
      if (JSON.stringify(r.items) !== S.lastListJson) renderList();
    } catch { /* offline: try again next tick */ }
  }, 15000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sheet.hidden && (location.hash === '' || location.hash === '#list')) renderList();
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
      <video id="scanVideo" playsinline muted></video>
      <p class="hint muted small" id="scanHint">Point the camera at the barcode.</p>
      <form class="row" id="manualCode"><input id="codeInput" class="grow" inputmode="numeric" placeholder="Or type the barcode"><button class="btn">Go</button></form>
    </div>`, stopScanner);
  const finish = (code) => { stopScanner(); closeSheet(); onCode(code); };
  sheetBody.onsubmit = (e) => { e.preventDefault(); const c = document.getElementById('codeInput').value.replace(/\D/g, ''); if (c) finish(c); };

  if (!window.ZXingBrowser || !navigator.mediaDevices) {
    document.getElementById('scanHint').textContent = 'Camera scanning isn’t available here (it needs HTTPS). Type the barcode instead.';
    return;
  }
  const reader = new ZXingBrowser.BrowserMultiFormatOneDReader();
  reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, document.getElementById('scanVideo'), (result) => {
    if (result) {
      if (navigator.vibrate) navigator.vibrate(60);
      finish(result.getText());
    }
  }).then((c) => {
    if (sheet.hidden) c.stop(); else scanControls = c;
  }).catch((err) => {
    const hint = document.getElementById('scanHint');
    if (hint) hint.textContent = `Camera error: ${err.message || err.name}. Allow camera access, or type the barcode.`;
  });
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
      if (r.product) {
        if (from === 'list') return quickAddSheet(r.product);
        return productEditor(r.product);
      }
      const s = r.suggestion || {};
      toast(r.suggestion ? 'Found on Open Food Facts. Check the details and add a price' : 'New product. Fill in the details');
      productEditor({
        id: null, barcode: r.barcode, name: s.name || '', brand: s.brand || '', pack_size: s.pack_size || 1,
        unit: s.unit || 'each', category: '', prices: {}, ...(s.nutrition || {}),
      }, { addToList: from === 'list' });
    } catch (er) { fail(er); }
  });
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
        p.bought_count ? `bought ${p.bought_count}×` : '', p.pantry > 0 ? `<span class="good-text">${fmtAmount(p.pantry, p.unit)} at home</span>` : ''].filter(Boolean);
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
async function renderProducts() {
  await loadProducts();
  const q = (store.get('prodSearch', '') || '').toLowerCase();
  view.innerHTML = `
    <div class="row">
      <input id="prodSearch" class="grow" placeholder="Search products" value="${esc(q)}" autocomplete="off">
      <button class="btn" data-act="scan" aria-label="Scan">📷</button>
      <button class="btn primary" data-act="new">＋</button>
    </div>
    <section class="card flush"><ul class="list" id="prodList"></ul></section>`;
  const listEl = document.getElementById('prodList');
  const draw = () => {
    const term = document.getElementById('prodSearch').value.trim().toLowerCase();
    store.set('prodSearch', term);
    const rows = S.products.filter((p) => !term || `${p.name} ${p.brand || ''} ${p.category || ''} ${p.barcode || ''}`.toLowerCase().includes(term));
    listEl.innerHTML = rows.length ? rows.map((p) => {
      const pr = priceAt(p.prices, S.storeId);
      const n = Object.keys(p.prices).length;
      return `<li class="tap" data-id="${p.id}"><div class="grow"><div class="name">${esc(p.name)}</div>
        <div class="sub">${[esc(p.brand || ''), packLabel(p), unitPrice(p, pr.price), p.pantry > 0 ? `<span class="good-text">${fmtAmount(p.pantry, p.unit)} at home</span>` : ''].filter(Boolean).join(' · ')}</div></div>
        <div class="right"><div class="num strong">${money(pr.price)}</div><div class="small muted">${pr.price === null ? 'no price' : pr.here ? esc(storeName(pr.storeId)) : `at ${esc(storeName(pr.storeId))}`}${n > 1 ? ` · ${n} shops` : ''}</div></div>
        <button type="button" class="icon-btn add-btn" data-add="${p.id}" aria-label="Add ${esc(p.name)} to the list">＋</button></li>`;
    }).join('') : `<li class="empty">${S.products.length ? 'No matches.' : 'No products yet. Scan something or tap ＋.'}</li>`;
  };
  draw();
  view.oninput = (e) => { if (e.target.id === 'prodSearch') draw(); };
  view.onclick = (e) => {
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'scan') return scanFlow('products');
    if (act && act.dataset.act === 'new') return productEditor({ id: null, name: '', brand: '', barcode: '', pack_size: 1, unit: 'each', category: '', prices: {} });
    const add = e.target.closest('[data-add]');
    if (add) {
      const p = S.products.find((x) => x.id === Number(add.dataset.add));
      api('list.add', { product_id: p.id, qty: 1 }).then(() => toast(`${p.name} added to the list`)).catch(fail);
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (li) productEditor(S.products.find((p) => p.id === Number(li.dataset.id)));
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
        ${S.stores.map((s) => `<label>${esc(s.name)} <input name="price_${s.id}" type="number" inputmode="decimal" step="0.01" min="0" value="${p.prices && p.prices[s.id] ? p.prices[s.id].price : ''}"></label>`).join('') || '<p class="muted small">Add shops on the Budget tab first.</p>'}
      </fieldset>

      <fieldset><legend id="nutLegend"></legend>
        <div class="grid2">${NUTRIENTS.map(([k, label, unit]) => `<label>${label} (${unit}) <input name="n_${k}" type="number" inputmode="decimal" step="0.01" min="0" value="${p[k] ?? ''}"></label>`).join('')}</div>
        <button type="button" class="btn small" data-act="off">Fill from Open Food Facts</button>
      </fieldset>

      <button class="btn primary block">${addToList ? 'Save & add to list' : 'Save'}</button>
      ${p.id ? `<button type="button" class="btn block" data-act="to-list">Add to list</button>
        <details><summary class="muted small">Price history</summary><div id="hist" class="small"></div></details>
        <button type="button" class="btn danger block" data-act="delete">Delete product</button>` : ''}
    </form>`);
  const form = document.getElementById('pForm');
  const legend = () => { document.getElementById('nutLegend').textContent = form.unit.value === 'each' ? 'Nutrition per item' : `Nutrition per 100 ${form.unit.value === 'ml' || form.unit.value === 'l' ? 'ml' : 'g'}`; };
  legend();
  sheetBody.onchange = (e) => { if (e.target.name === 'unit') legend(); };

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
        const snapshot = collect();
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
        if (!s.has_nutrition) return toast('Found, but no nutrition info listed');
        for (const [k] of NUTRIENTS) if (s.nutrition[k] !== null) form[`n_${k}`].value = s.nutrition[k];
        toast('Nutrition filled in. Check it against the label');
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
    };
  }

  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = collect();
      const { product } = await api('products.save', { id: p.id, ...data });
      const home = form.pantry.value === '' ? 0 : Number(form.pantry.value);
      if (home !== (p.pantry || 0)) await api('pantry.set', { product_id: product.id, amount: home });
      if (addToList) await api('list.add', { product_id: product.id, qty: 1 });
      closeSheet();
      toast(addToList ? 'Saved and added to list' : 'Saved');
      await loadProducts();
      route();
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
  view.innerHTML = `
    <button class="btn primary block" data-act="new">＋ New recipe</button>
    ${recipes.length ? recipes.map((r) => {
      const time = (r.prep_minutes || 0) + (r.cook_minutes || 0);
      const steps = recipeSteps(r).length;
      return `<article class="card stack tap" data-id="${r.id}">
        <div class="row"><h2 class="grow">${esc(r.name)}</h2><span class="num strong">${money(r.cost_per_serving)}<span class="small muted"> /portion</span></span></div>
        <div class="small muted">${r.servings} portion${r.servings > 1 ? 's' : ''} · ${money(r.cost)} a batch${time ? ` · ${fmtMins(time)}` : ''}${steps ? ` · ${steps} step${steps > 1 ? 's' : ''}` : ''}
          ${r.missing_prices ? `<span class="tag warn">${r.missing_prices} unpriced</span>` : ''}</div>
        ${nutriHtml(r.nutrition_per_serving, r.missing_nutrition, r.items.length)}
      </article>`;
    }).join('') : '<p class="empty">No recipes yet. Add the meals you prep: ingredients come from your products, so cost and nutrition work themselves out.</p>'}`;
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
    const packs = Math.max(1, Math.ceil(amount / it.pack_size - 1e-6));
    const cost = price === null ? null : (amount / it.pack_size) * price;
    if (price === null) missing++;
    else { used += cost; toBuy += packs * price; }
    return { ...it, amount, packs, cost };
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
          <button type="button" class="btn small" data-act="makes">Change</button>
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
        ${sc.missing ? `<p class="small warn-text">${sc.missing} ingredient${sc.missing > 1 ? 's have' : ' has'} no price yet, so costs are low.</p>` : ''}
        ${n !== r.servings ? `<p class="small muted">Amounts scaled from the recipe's ${r.servings} portions.</p>` : ''}
      </section>

      <button class="btn primary block" data-act="cook">Start cook mode</button>

      <section class="stack">
        <h3>Ingredients</h3>
        <ul class="ing-list">${sc.items.map((it) => `<li>
          <span class="amt num">${fmtAmount(it.amount, it.unit)}</span>
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
        <button class="btn" data-act="edit">Edit recipe</button>
      </div>
      <button class="btn block danger" data-act="delete">Delete recipe</button>`);
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
          case 'delete':
            if (!confirm(`Delete ${r.name}? Recipes are shared, so it's deleted for both of you and comes off both meal plans.`)) return;
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
        <ul class="ing-list check">${sc.items.map((it) => `<li><label class="row grow"><input type="checkbox"><span class="amt num">${fmtAmount(it.amount, it.unit)}</span><span class="grow">${esc(it.name)}${it.note ? `<span class="muted">, ${esc(it.note)}</span>` : ''}</span></label></li>`).join('')}</ul>
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
            else if (location.hash === '' || location.hash === '#list') route();
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
  let rows = r.items.map((i) => ({ product_id: i.product_id, amount: i.amount, note: i.note || '' }));
  let steps = (r.steps && r.steps.length ? r.steps : recipeSteps(r)).map((s) => ({ body: s.body, timer_minutes: s.timer_minutes }));
  const notes = r.steps && r.steps.length ? (r.instructions || '') : '';
  const prodOptions = (sel) => `<option value="">Choose product…</option>` + S.products.map((p) =>
    `<option value="${p.id}" ${p.id === Number(sel) ? 'selected' : ''}>${esc(p.name)}${p.brand ? ` (${esc(p.brand)})` : ''}</option>`).join('');

  openSheet(`${sheetHead(r.id ? 'Edit recipe' : 'New recipe')}
    <form class="stack" id="rForm">
      <label>Name <input name="name" required value="${esc(r.name)}" placeholder="Chicken & rice prep"></label>
      <div class="grid3">
        <label>Portions <input name="servings" type="number" inputmode="numeric" min="1" step="1" value="${r.servings}"></label>
        <label>Prep (min) <input name="prep_minutes" type="number" inputmode="numeric" min="0" value="${r.prep_minutes ?? ''}"></label>
        <label>Cook (min) <input name="cook_minutes" type="number" inputmode="numeric" min="0" value="${r.cook_minutes ?? ''}"></label>
      </div>
      <fieldset><legend>Ingredients (amount in the product's unit)</legend>
        <div id="ingRows" class="stack"></div>
        <button type="button" class="btn small" data-act="add-ing">＋ Ingredient</button>
        ${S.products.length ? '' : '<p class="small warn-text">Add products first. Ingredients are picked from your products.</p>'}
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
      const p = S.products.find((x) => x.id === Number(row.product_id));
      return `<div class="ing" data-i="${i}">
        <select data-f="product_id" aria-label="Product">${prodOptions(row.product_id)}</select>
        <div class="ing-row">
          <input data-f="amount" type="number" inputmode="decimal" step="0.001" min="0" value="${row.amount ?? ''}" placeholder="${p ? p.unit : 'qty'}" aria-label="Amount">
          <span class="small muted">${p ? (p.unit === 'each' ? 'items' : p.unit) : ''}</span>
          <input data-f="note" value="${esc(row.note)}" placeholder="note, e.g. diced" aria-label="Note">
          <button type="button" class="icon-btn" data-act="rm-ing" aria-label="Remove ingredient">✕</button>
        </div>
      </div>`;
    }).join('') || '<p class="muted small">No ingredients yet.</p>';
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
    const tmp = { servings, items: rows.filter((x) => x.product_id && x.amount).map((x) => {
      const p = S.products.find((pp) => pp.id === Number(x.product_id));
      return { product_id: p.id, name: p.name, unit: p.unit, pack_size: p.pack_size, amount: Number(x.amount) };
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
      rows[Number(ing.dataset.i)][f] = f === 'note' ? e.target.value : (e.target.value === '' ? null : Number(e.target.value));
      if (f === 'product_id') drawRows(); else summary();
    } else if (st) {
      const f = e.target.dataset.f;
      steps[Number(st.dataset.s)][f] = f === 'body' ? e.target.value : (e.target.value === '' ? null : Number(e.target.value));
    } else summary();
  };
  sheetBody.onchange = (e) => { if (e.target.dataset.f === 'product_id') sheetBody.oninput(e); };
  sheetBody.onclick = async (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const si = act.closest('.step-row') ? Number(act.closest('.step-row').dataset.s) : null;
    switch (act.dataset.act) {
      case 'add-ing': rows.push({ product_id: null, amount: null, note: '' }); return drawRows();
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
        items: rows.filter((x) => x.product_id && x.amount),
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
function fmtAmount(amount, unit) {
  if (unit === 'g' && amount >= 1000) return `${round(amount / 1000, 2)} kg`;
  if (unit === 'ml' && amount >= 1000) return `${round(amount / 1000, 2)} l`;
  if (unit === 'each') return `${round(amount, 1)}×`;
  return `${round(amount, 2)} ${unit}`;
}

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

    <button class="btn primary block" data-act="wizard">${entries.length ? 'Re-plan this week' : 'Plan my week'}</button>

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
          location.hash = '#list';
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
      ${!me.protein_target_g && !me.kj_target ? '<span class="muted">Set your daily targets on the Budget tab.</span>' : ''}
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
async function renderBudget() {
  const month = store.get('budgetMonth', null) || S.month;
  const b = await api('budget.get', { month });
  S.aisles = b.aisle_order || [];
  if (month === S.month) { S.spent = b.spent; S.budget = b.budget; updatePill(); }
  const left = b.budget - b.spent;
  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  const isCurrent = y === now.getFullYear() && m === now.getMonth() + 1;
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysLeft = isCurrent ? daysInMonth - now.getDate() + 1 : 0;
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const shift = (n) => { const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

  view.innerHTML = `
    <div class="row">
      <button class="btn small" data-month="${shift(-1)}">‹</button>
      <button class="btn small grow" data-month="${S.month}">${monthLabel}</button>
      <button class="btn small" data-month="${shift(1)}">›</button>
    </div>
    <section class="card stack">
      <div class="grid3 right">
        <div><div class="small muted">Budget</div><b class="num">${money(b.budget)}</b></div>
        <div><div class="small muted">Spent</div><b class="num">${money(b.spent)}</b></div>
        <div><div class="small muted">Left</div><b class="num ${left < 0 ? 'bad-text' : 'good-text'}">${money(left)}</b></div>
      </div>
      <div class="meter ${left < 0 ? 'bad' : left < b.budget * 0.2 ? 'warn' : ''}"><div id="bMeter"></div></div>
      ${isCurrent && left > 0 ? `<p class="small muted">${daysLeft} day${daysLeft === 1 ? '' : 's'} left, so about ${money(left / daysLeft)} a day or ${money((left / daysLeft) * 7)} a week.</p>` : ''}
      ${left < 0 ? `<p class="small bad-text">Over budget by ${money(-left)}.</p>` : ''}
    </section>

    <section class="card stack">
      <div class="row between"><h2>Takeaways</h2><button class="btn small" data-act="log-ta">＋ Log</button></div>
      <div class="grid2 right">
        <div><div class="small muted">This month</div><b class="num ${b.eating_out > b.takeaway_weekly * 52 / 12 ? 'bad-text' : ''}">${money(b.eating_out)}</b></div>
        <div><div class="small muted">Allowance a month</div><b class="num">${money(b.takeaway_weekly * 52 / 12)}</b></div>
      </div>
      <p class="small muted">Kept separate from groceries, so the grocery budget stays honest.</p>
    </section>

    <section class="card flush">
      <div class="section-head"><h2 class="grow">Shops this month</h2><button class="btn small" data-act="add-trip">＋ Log spend</button></div>
      <ul class="list">${b.trips.map((t) => `<li><div class="grow"><div class="name">${esc(t.store || (t.kind === 'eating_out' ? (t.note || 'Takeaway') : 'Other'))}${t.kind === 'eating_out' ? '<span class="tag warn">takeaway</span>' : ''}</div>
        <div class="sub">${esc(t.trip_date)}${t.who ? ` · ${esc(t.who)}` : ''}${t.note && t.kind !== 'eating_out' ? ` · ${esc(t.note)}` : ''}${t.estimate !== null && t.estimate !== undefined && t.estimate > 0 ? ` · <span class="${Math.abs(t.total - t.estimate) / t.estimate > 0.05 ? 'warn-text' : 'good-text'}">est. ${money(t.estimate)}</span>` : ''}</div></div>
        <b class="num">${money(t.total)}</b><button class="icon-btn" data-del-trip="${t.id}" aria-label="Delete">✕</button></li>`).join('') || '<li class="empty">No shops logged yet.</li>'}</ul>
    </section>

    <section class="card stack">
      <h2>Settings</h2>
      <form class="row" id="budgetForm"><label class="grow">Monthly grocery budget (R) <input name="monthly_budget" type="number" inputmode="decimal" step="0.01" min="0" value="${b.budget}"></label><button class="btn">Save</button></form>
      <form class="stack" id="targets"><span class="small muted">My daily targets</span>
        <div class="grid2">
          <label>Protein (g) <input name="protein" type="number" inputmode="numeric" min="0" value="${(S.users.find((u) => u.id === S.user.id) || {}).protein_target_g ?? ''}"></label>
          <label>Energy (kJ) <input name="kj" type="number" inputmode="numeric" min="0" value="${(S.users.find((u) => u.id === S.user.id) || {}).kj_target ?? ''}"></label>
        </div>
        <button class="btn">Save targets</button></form>
      <div class="stack tight"><span class="small muted">Aisle order (how the shopping list is grouped)</span>
        <ul class="list card flush" id="aisleEd">${(S.aisles || []).map((a, i) => `<li><span class="grow">${esc(a)}</span><button type="button" class="icon-btn" data-aisle-up="${i}" aria-label="Move ${esc(a)} up" ${i ? '' : 'disabled'}>↑</button><button type="button" class="icon-btn" data-aisle-del="${i}" aria-label="Remove ${esc(a)}">✕</button></li>`).join('')}</ul>
        <form class="row" id="aisleAdd"><input name="aisle" class="grow" placeholder="Add an aisle"><button class="btn">Add</button></form>
      </div>
      <form class="row" id="taWeekly"><label class="grow">Weekly takeaway allowance (R) <input name="weekly" type="number" inputmode="decimal" step="0.01" min="0" value="${b.takeaway_weekly}"></label><button class="btn">Save</button></form>
      <div>
        <div class="small muted">Shops</div>
        <ul class="list">${S.stores.map((s) => `<li><span class="grow">${esc(s.name)}</span><button class="btn small" data-rename="${s.id}">Rename</button><button class="icon-btn" data-del-store="${s.id}" aria-label="Delete">✕</button></li>`).join('')}</ul>
        <form class="row" id="storeForm"><input name="name" class="grow" placeholder="Add a shop"><button class="btn">Add</button></form>
      </div>
      <p class="small muted">Logged in as ${esc(S.user.display_name)}.</p>
      <div class="row"><button class="btn small grow" data-act="password">Change password</button><button class="btn small grow" data-act="logout">Log out</button></div>
      <p class="small muted" id="dispCheck"></p>
    </section>`;
  document.getElementById('bMeter').style.width = `${Math.min(100, b.budget > 0 ? (b.spent / b.budget) * 100 : 100)}%`;

  const dc = document.getElementById('dispCheck');
  if (dc) dc.textContent = displayCheck();
  const refreshStores = async () => { S.stores = (await api('bootstrap')).stores; };

  view.onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'budgetForm') { await api('budget.set', { monthly_budget: e.target.monthly_budget.value }); S.budget = Number(e.target.monthly_budget.value); toast('Budget saved'); }
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
      renderBudget();
    } catch (er) { fail(er); }
  };
  view.onclick = async (e) => {
    const t = e.target.closest('[data-month],[data-act],[data-del-trip],[data-del-store],[data-rename],[data-aisle-up],[data-aisle-del]');
    if (!t) return;
    try {
      if (t.dataset.aisleUp || t.dataset.aisleDel) {
        const order = [...S.aisles];
        if (t.dataset.aisleUp) { const i = Number(t.dataset.aisleUp); [order[i - 1], order[i]] = [order[i], order[i - 1]]; }
        else order.splice(Number(t.dataset.aisleDel), 1);
        S.aisles = (await api('aisles.set', { order })).aisle_order;
        return renderBudget();
      }
      if (t.dataset.month) { store.set('budgetMonth', t.dataset.month); return renderBudget(); }
      if (t.dataset.delTrip) { if (!confirm('Delete this logged shop?')) return; await api('trips.delete', { id: t.dataset.delTrip }); return renderBudget(); }
      if (t.dataset.delStore) {
        if (!confirm(`Delete ${storeName(t.dataset.delStore)}? All its saved prices go too.`)) return;
        await api('stores.delete', { id: t.dataset.delStore }); await refreshStores();
        if (String(S.storeId) === String(t.dataset.delStore)) S.storeId = S.stores[0] ? String(S.stores[0].id) : null;
        return renderBudget();
      }
      if (t.dataset.rename) {
        const name = prompt('New name', storeName(t.dataset.rename));
        if (!name) return;
        await api('stores.rename', { id: t.dataset.rename, name }); await refreshStores(); return renderBudget();
      }
      if (t.dataset.act === 'add-trip') return tripSheet();
      if (t.dataset.act === 'log-ta') return takeawaySheet(() => renderBudget());
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
      closeSheet(); renderBudget();
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

/* ---------- start ---------- */
(async function init() {
  try {
    const b = await api('bootstrap');
    Object.assign(S, { user: b.user, users: b.users, stores: b.stores, budget: b.budget, spent: b.spent, month: b.month });
    const saved = store.get('store', null);
    S.storeId = S.stores.some((s) => String(s.id) === String(saved)) ? String(saved) : (S.stores[0] ? String(S.stores[0].id) : null);
    store.set('budgetMonth', null);
    updatePill();
    route();
  } catch (e) {
    view.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
})();
