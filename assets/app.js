'use strict';

/* ---------- basics ---------- */
const CSRF = document.querySelector('meta[name=csrf]').content;
const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const titleEl = document.getElementById('title');
const pill = document.getElementById('budgetPill');

const S = { user: null, users: [], stores: [], budget: 0, spent: 0, month: '', products: [], storeId: null };
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

async function api(action, data = {}) {
  let res;
  try {
    res = await fetch('api.php', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF': CSRF },
      body: JSON.stringify({ action, ...data }),
    });
  } catch {
    throw new Error('No connection');
  }
  if (res.status === 401 || res.status === 419) { location.reload(); throw new Error('Session expired'); }
  let json = {};
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(json.error || 'Something went wrong');
  return json;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '—'
  : 'R' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/* ---------- sheet (bottom drawer) ---------- */
let sheetOnClose = null;
function openSheet(html, onClose = null) {
  sheetBody.innerHTML = html;
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
  pill.textContent = `${money(left)} left`;
  pill.className = 'pill' + (left < 0 ? ' bad' : left < S.budget * 0.2 ? ' warn' : '');
}
pill.addEventListener('click', () => { location.hash = '#budget'; });

/* ---------- routing ---------- */
const routes = { list: ['List', renderList], products: ['Products', renderProducts], plan: ['Meal plan', renderPlan], recipes: ['Recipes', renderRecipes], budget: ['Budget', renderBudget] };
async function route() {
  const key = (location.hash || '#list').slice(1).split('/')[0];
  const [title, fn] = routes[key] || routes.list;
  titleEl.textContent = title;
  document.body.className = `route-${routes[key] ? key : 'list'}`;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === key));
  view.onclick = view.oninput = view.onchange = view.onsubmit = null;
  view.innerHTML = '<p class="empty">Loading…</p>';
  try { await fn(); } catch (e) { view.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
window.addEventListener('hashchange', () => { if (!sheet.hidden) closeSheet(); route(); });

async function loadProducts() {
  S.products = (await api('products.list')).products;
  return S.products;
}

function storeSelect(id = 'storeSel', selected = S.storeId, allowNone = false) {
  return `<select id="${id}">${allowNone ? '<option value="">— no shop —</option>' : ''}${S.stores.map((s) =>
    `<option value="${s.id}" ${String(s.id) === String(selected) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}

/* ================= LIST ================= */
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
  const [{ items, spent, budget }] = await Promise.all([api('list.get'), S.products.length ? null : loadProducts()]);
  S.spent = spent; S.budget = budget; updatePill();

  const lines = items.map((it) => ({ it, p: itemPrice(it) }));
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

  view.innerHTML = `
    <section class="ring-card">
      ${ringSvg(spent, listTotal, budget)}
      <div class="ring-text">
        <span class="small muted">Left for ${esc(monthName)}</span>
        <span class="big">${money0(left)}</span>
        ${items.length ? `<span class="small ${after < 0 ? 'bad-text' : 'good-text'}">${after < 0 ? `${money0(-after)} over after this list` : `${money0(after)} after this list`}</span>` : `<span class="small muted">of ${money0(budget)} this month</span>`}
      </div>
    </section>

    <div class="chips" role="group" aria-label="Shop you're in">
      ${compare.map((c) => {
        const detail = !c.count ? '' : c.known === c.count ? ` · <span class="num">${money0(c.total)}</span>` : ` <span class="sub">${c.known}/${c.count}</span>`;
        return `<button type="button" class="chip ${c.id === String(S.storeId) ? 'active' : ''}" data-store="${c.id}" aria-pressed="${c.id === String(S.storeId)}">${esc(c.name)}${detail}${c.id === cheapest ? ' <span class="best">✓</span>' : ''}</button>`;
      }).join('')}
    </div>

    <div class="heading-row"><h1>To buy <span class="muted">${open.length}</span></h1><span class="num strong">${money(openTotal)}</span></div>
    ${open.length ? `<ul class="items">${open.map(rowHtml).join('')}</ul>`
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
      <button class="scan" type="button" data-act="scan" aria-label="Scan a barcode">${ICON_SCAN}</button>
    </div>`;

  function rowHtml({ it, p }) {
    const sub = [];
    if (it.brand) sub.push(esc(it.brand));
    const pk = packLabel(it);
    if (pk) sub.push(pk);
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
      return `<button data-pid="${p.id}"><span>${esc(p.name)} <span class="muted small">${esc(p.brand || '')} ${packLabel(p)}</span></span><span class="num small">${money(pr.price)}</span></button>`;
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
          if (it.qty <= 1) { if (!confirm(`Remove ${it.name}?`)) return; await api('list.delete', { id: it.id }); }
          else await api('list.update', { id: it.id, qty: it.qty - 1 });
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
        case 'checkout': return checkoutSheet(checkedTotal);
        case 'clear-checked': if (!confirm('Remove ticked items without logging a shop?')) return; await api('list.clear'); break;
        case 'clear-all': if (!confirm('Clear the whole list?')) return; await api('list.clear', { all: true }); break;
        default: return;
      }
      renderList();
    } catch (er) { fail(er); }
  };
}

function checkoutSheet(estimate) {
  openSheet(`${sheetHead('Finish shop')}
    <form class="stack" id="coForm">
      <p class="muted small">Ticked items come off the list and the amount is logged against this month's budget. Use the total on your till slip.</p>
      <label>Shop ${storeSelect('coStore', S.storeId, true)}</label>
      <label>Total paid (R) <input id="coTotal" type="number" inputmode="decimal" step="0.01" min="0" value="${round(estimate, 2)}"></label>
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
      toast(`Logged ${money(r.total)}`);
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
  const pr = priceAt(p.prices, S.storeId);
  openSheet(`${sheetHead(p.name)}
    <form class="stack" id="qaForm">
      <p class="muted small">${esc(p.brand || '')} ${packLabel(p)}</p>
      <label>Price at ${esc(storeName(S.storeId))} (R) <input id="qaPrice" type="number" inputmode="decimal" step="0.01" min="0" value="${pr.here ? pr.price : ''}" placeholder="${pr.price !== null ? `${storeName(pr.storeId)}: ${pr.price}` : ''}"></label>
      <label>How many <input id="qaQty" type="number" inputmode="decimal" step="1" min="1" value="1"></label>
      <button class="btn primary block">Add to list</button>
      <button class="btn block" type="button" data-act="edit">Edit product</button>
    </form>`);
  sheetBody.onclick = (e) => { if (e.target.closest('[data-act=edit]')) { closeSheet(); productEditor(p); } };
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const price = document.getElementById('qaPrice').value;
      if (price !== '' && S.storeId) await api('products.price', { product_id: p.id, store_id: S.storeId, price });
      await api('list.add', { product_id: p.id, qty: document.getElementById('qaQty').value || 1 });
      closeSheet(); toast('Added'); loadProducts().then(route);
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
        <div class="sub">${[esc(p.brand || ''), packLabel(p), p.energy_kj !== null || p.protein_g !== null ? 'nutrition ✓' : ''].filter(Boolean).join(' · ')}</div></div>
        <div class="right"><div class="num strong">${money(pr.price)}</div><div class="small muted">${pr.price === null ? 'no price' : pr.here ? esc(storeName(pr.storeId)) : `at ${esc(storeName(pr.storeId))}`}${n > 1 ? ` · ${n} shops` : ''}</div></div></li>`;
    }).join('') : `<li class="empty">${S.products.length ? 'No matches.' : 'No products yet. Scan something or tap ＋.'}</li>`;
  };
  draw();
  view.oninput = (e) => { if (e.target.id === 'prodSearch') draw(); };
  view.onclick = (e) => {
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'scan') return scanFlow('products');
    if (act && act.dataset.act === 'new') return productEditor({ id: null, name: '', brand: '', barcode: '', pack_size: 1, unit: 'each', category: '', prices: {} });
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
        <label>Category <input name="category" value="${esc(p.category || '')}" placeholder="Meat, dairy…"></label>
      </div>
      <div class="grid2">
        <label>Pack size <input name="pack_size" type="number" inputmode="decimal" step="0.001" min="0.001" value="${p.pack_size || 1}"></label>
        <label>Unit <select name="unit">${UNITS.map((u) => `<option ${u === p.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      </div>
      <div class="row"><label class="grow">Barcode <input name="barcode" inputmode="numeric" value="${esc(p.barcode || '')}"></label><button type="button" class="btn" data-act="scan-code">📷</button></div>

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
      if (addToList) await api('list.add', { product_id: product.id, qty: 1 });
      closeSheet();
      toast(addToList ? 'Saved and added to list' : 'Saved');
      await loadProducts();
      route();
    } catch (er) { fail(er); }
  };
}

/* ================= RECIPES ================= */
async function renderRecipes() {
  const [{ recipes }] = await Promise.all([api('recipes.list'), loadProducts()]);
  S.recipes = recipes;
  view.innerHTML = `
    <button class="btn primary block" data-act="new">＋ New recipe</button>
    ${recipes.length ? recipes.map((r) => `
      <article class="card stack tap" data-id="${r.id}">
        <div class="row"><h2 class="grow">${esc(r.name)}</h2><span class="num strong">${money(r.cost_per_serving)}<span class="small muted"> /serving</span></span></div>
        <div class="small muted">${r.servings} serving${r.servings > 1 ? 's' : ''} · ${money(r.cost)} total · ${r.items.length} ingredient${r.items.length === 1 ? '' : 's'}
          ${r.missing_prices ? `<span class="tag warn">${r.missing_prices} unpriced</span>` : ''}</div>
        ${nutriHtml(r.nutrition_per_serving, r.missing_nutrition, r.items.length)}
      </article>`).join('') : '<p class="empty">No recipes yet. Add the meals you prep. Each ingredient is a product, so the cost works itself out.</p>'}`;
  view.onclick = (e) => {
    if (e.target.closest('[data-act=new]')) return recipeEditor({ id: null, name: '', servings: 4, instructions: '', items: [] });
    const card = e.target.closest('[data-id]');
    if (card) recipeEditor(recipes.find((r) => r.id === Number(card.dataset.id)));
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

function recipeEditor(r) {
  let rows = r.items.map((i) => ({ product_id: i.product_id, amount: i.amount }));
  const prodOptions = (sel) => `<option value="">Choose product…</option>` + S.products.map((p) =>
    `<option value="${p.id}" ${p.id === Number(sel) ? 'selected' : ''}>${esc(p.name)}${p.brand ? ` (${esc(p.brand)})` : ''}</option>`).join('');

  openSheet(`${sheetHead(r.id ? 'Edit recipe' : 'New recipe')}
    <form class="stack" id="rForm">
      <label>Name <input name="name" required value="${esc(r.name)}" placeholder="Chicken & rice prep"></label>
      <label>Servings it makes <input name="servings" type="number" min="1" step="1" value="${r.servings}"></label>
      <fieldset><legend>Ingredients (amount in the product's unit)</legend>
        <div id="ingRows" class="stack"></div>
        <button type="button" class="btn small" data-act="add-ing">＋ Ingredient</button>
        ${S.products.length ? '' : '<p class="small warn-text">Add products first. Ingredients are picked from your products.</p>'}
      </fieldset>
      <div class="card stack" id="rSummary"></div>
      <label>Method / notes <textarea name="instructions" placeholder="Cook rice, bake chicken 25 min at 200°C…">${esc(r.instructions || '')}</textarea></label>
      <button class="btn primary block">Save recipe</button>
      ${r.id ? `<button type="button" class="btn block" data-act="plan">Add to meal plan</button>
        <button type="button" class="btn danger block" data-act="delete">Delete recipe</button>` : ''}
    </form>`);
  const form = document.getElementById('rForm');
  const box = document.getElementById('ingRows');

  const drawRows = () => {
    box.innerHTML = rows.map((row, i) => {
      const p = S.products.find((x) => x.id === Number(row.product_id));
      return `<div class="ing-row" data-i="${i}">
        <select data-f="product_id">${prodOptions(row.product_id)}</select>
        <input data-f="amount" type="number" inputmode="decimal" step="0.001" min="0" value="${row.amount ?? ''}" placeholder="${p ? p.unit : 'qty'}" aria-label="Amount">
        <span class="small muted">${p ? (p.unit === 'each' ? 'items' : p.unit) : ''}</span>
        <button type="button" class="icon-btn" data-act="rm-ing" aria-label="Remove">✕</button>
      </div>`;
    }).join('') || '<p class="muted small">No ingredients yet.</p>';
    summary();
  };
  const summary = () => {
    const servings = Math.max(1, Number(form.servings.value) || 1);
    let cost = 0; let missing = 0;
    const lines = rows.map((row) => {
      const p = S.products.find((x) => x.id === Number(row.product_id));
      if (!p || !row.amount) return '';
      const pr = priceAt(p.prices, null).price;
      const c = pr === null ? null : (row.amount / p.pack_size) * pr;
      if (c === null) missing++; else cost += c;
      return `<div class="row small"><span class="grow">${fmtQty(row.amount)} ${p.unit === 'each' ? '×' : p.unit} ${esc(p.name)}</span><span class="num">${money(c)}</span></div>`;
    }).join('');
    document.getElementById('rSummary').innerHTML = `${lines}
      <div class="row"><b class="grow">Cost (cheapest prices)</b><b class="num">${money(cost)}</b></div>
      <div class="row small muted"><span class="grow">Per serving</span><span class="num">${money(cost / servings)}</span></div>
      ${missing ? `<div class="small warn-text">${missing} ingredient${missing > 1 ? 's' : ''} without a price</div>` : ''}`;
  };
  drawRows();

  sheetBody.oninput = (e) => {
    const rowEl = e.target.closest('.ing-row');
    if (rowEl) rows[Number(rowEl.dataset.i)][e.target.dataset.f] = e.target.value === '' ? null : Number(e.target.value);
    if (rowEl && e.target.dataset.f === 'product_id') drawRows(); else summary();
  };
  sheetBody.onchange = sheetBody.oninput;
  sheetBody.onclick = async (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'add-ing') { rows.push({ product_id: null, amount: null }); drawRows(); return; }
    if (act.dataset.act === 'rm-ing') { rows.splice(Number(act.closest('.ing-row').dataset.i), 1); drawRows(); return; }
    if (act.dataset.act === 'plan') { closeSheet(); return planAddSheet(iso(new Date()), r.id); }
    if (act.dataset.act === 'delete') {
      if (!confirm(`Delete ${r.name}? It will also come off the meal plan.`)) return;
      try { await api('recipes.delete', { id: r.id }); closeSheet(); route(); } catch (er) { fail(er); }
    }
  };
  sheetBody.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('recipes.save', {
        id: r.id, name: form.name.value, servings: form.servings.value, instructions: form.instructions.value,
        items: rows.filter((x) => x.product_id && x.amount),
      });
      closeSheet(); toast('Recipe saved'); route();
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
  const [{ entries }, { recipes }] = await Promise.all([
    api('plan.get', { from: iso(start), to: iso(end) }),
    api('recipes.list'),
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

  // what the week needs cooked, for prep day
  const recipeById = Object.fromEntries(recipes.map((r) => [r.id, r]));
  const need = {};
  let portions = 0;
  for (const e of entries) {
    const r = recipeById[e.recipe_id];
    if (!r) continue;
    portions += e.servings;
    for (const it of r.items) {
      const k = it.product_id;
      need[k] = need[k] || { name: it.name, unit: it.unit, amount: 0 };
      need[k].amount += it.amount * e.servings / r.servings;
    }
  }
  const needList = Object.values(need).sort((a, b) => b.amount - a.amount);

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
      ${dayEntries.map((e) => `<div class="meal">
        <span class="t">${esc(e.slot)}</span>
        <div class="grow"><div class="strong">${esc(e.recipe)}${e.servings !== 1 ? ` <span class="muted">×${fmtQty(e.servings)}</span>` : ''}</div>${e.protein_g ? `<div class="small muted">${Math.round(e.protein_g)} g protein</div>` : ''}</div>
        <span class="num strong">${money(e.cost)}</span>
        <button class="icon-btn" data-del="${e.id}" aria-label="Remove ${esc(e.recipe)}">✕</button>
      </div>`).join('')}
      ${dayProtein ? `<div class="row between small"><span class="muted">Protein ${dayEntries.length > 1 ? 'today' : ''}</span><span class="strong">${Math.round(dayProtein)} g</span></div>` : ''}
      <button class="btn small" data-add="${sel}">＋ Add a meal</button>
    </section>

    ${needList.length ? `<section class="prep-card">
      ${ICON_POT}
      <div class="grow stack tight">
        <span class="strong">Prep for this week</span>
        <span class="small muted">${needList.map((n) => `${fmtAmount(n.amount, n.unit)} ${esc(n.name)}`).join(', ')}. Makes ${fmtQty(portions)} portion${portions === 1 ? '' : 's'}.</span>
      </div>
    </section>` : ''}

    <button class="btn primary block" data-act="to-list" ${entries.length ? '' : 'disabled'}>Put the week on my list</button>`;

  view.querySelectorAll('.mark').forEach((m) => { m.style.width = `${Math.min(30, 6 + Number(m.dataset.n) * 6)}px`; });

  view.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-add],[data-del],[data-day]');
    if (!t) return;
    try {
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

async function planAddSheet(date, recipeId = null) {
  if (!S.recipes) S.recipes = (await api('recipes.list')).recipes;
  if (!S.recipes.length) { toast('Add a recipe first'); location.hash = '#recipes'; return; }
  openSheet(`${sheetHead('Add meal')}
    <form class="stack" id="plForm">
      <label>Day <input name="date" type="date" value="${date}"></label>
      <label>Meal <select name="slot">${SLOTS.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label>
      <label>Recipe <select name="recipe_id">${S.recipes.map((r) => `<option value="${r.id}" ${r.id === recipeId ? 'selected' : ''}>${esc(r.name)} (${money(r.cost_per_serving)}/serving)</option>`).join('')}</select></label>
      <label>Servings <input name="servings" type="number" inputmode="decimal" min="0.25" step="0.25" value="${S.users.length > 1 ? 2 : 1}"></label>
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

    <section class="card flush">
      <div class="section-head"><h2 class="grow">Shops this month</h2><button class="btn small" data-act="add-trip">＋ Log spend</button></div>
      <ul class="list">${b.trips.map((t) => `<li><div class="grow"><div class="name">${esc(t.store || 'Other')}</div>
        <div class="sub">${esc(t.trip_date)}${t.who ? ` · ${esc(t.who)}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</div></div>
        <b class="num">${money(t.total)}</b><button class="icon-btn" data-del-trip="${t.id}" aria-label="Delete">✕</button></li>`).join('') || '<li class="empty">No shops logged yet.</li>'}</ul>
    </section>

    <section class="card stack">
      <h2>Settings</h2>
      <form class="row" id="budgetForm"><label class="grow">Monthly grocery budget (R) <input name="monthly_budget" type="number" inputmode="decimal" step="0.01" min="0" value="${b.budget}"></label><button class="btn">Save</button></form>
      <div>
        <div class="small muted">Shops</div>
        <ul class="list">${S.stores.map((s) => `<li><span class="grow">${esc(s.name)}</span><button class="btn small" data-rename="${s.id}">Rename</button><button class="icon-btn" data-del-store="${s.id}" aria-label="Delete">✕</button></li>`).join('')}</ul>
        <form class="row" id="storeForm"><input name="name" class="grow" placeholder="Add a shop"><button class="btn">Add</button></form>
      </div>
      <p class="small muted">Logged in as ${esc(S.user.display_name)}.</p>
      <div class="row"><button class="btn small grow" data-act="password">Change password</button><button class="btn small grow" data-act="logout">Log out</button></div>
    </section>`;
  document.getElementById('bMeter').style.width = `${Math.min(100, b.budget > 0 ? (b.spent / b.budget) * 100 : 100)}%`;

  const refreshStores = async () => { S.stores = (await api('bootstrap')).stores; };

  view.onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'budgetForm') { await api('budget.set', { monthly_budget: e.target.monthly_budget.value }); S.budget = Number(e.target.monthly_budget.value); toast('Budget saved'); }
      if (e.target.id === 'storeForm') { await api('stores.add', { name: e.target.name.value }); await refreshStores(); }
      renderBudget();
    } catch (er) { fail(er); }
  };
  view.onclick = async (e) => {
    const t = e.target.closest('[data-month],[data-act],[data-del-trip],[data-del-store],[data-rename]');
    if (!t) return;
    try {
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
      if (t.dataset.act === 'logout') { await api('logout'); location.reload(); }
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
