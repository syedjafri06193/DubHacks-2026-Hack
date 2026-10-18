// Last Call — mobile-first PWA client (vanilla JS, hash routes).
const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $$ = c => `$${(c / 100).toFixed(2)}`;
let me = null, draft = null, es = null;

async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(`/api/v1${path}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${r.status}`), { code: j.error?.code, status: r.status });
  return j;
}
function toast(html, kind = '', ms = 4500) {
  const t = document.createElement('div'); t.className = `toast ${kind}`; t.innerHTML = html;
  $('#toasts').prepend(t); setTimeout(() => t.remove(), ms);
}
const timeLeft = ms => { const m = Math.max(0, Math.round((ms - Date.now()) / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const tagPills = tags => (tags || []).map(t => `<span class="pill ${t.startsWith('contains') ? 'amber' : ''}">${esc(t.replace('contains-', 'has '))}</span>`).join('');

// ---------- shell ----------
function renderShell() {
  $('#who').innerHTML = me ? `<span>${esc(me.name)}</span><button id="logout">Switch</button>` : '';
  if (me) $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); me = null; es?.close(); location.hash = '#/'; renderShell(); };
  const tabs = !me ? [] : me.role === 'buyer'
    ? [['#/deals', '🥐', 'Deals'], ['#/me', '🎟️', 'My orders'], ['#/impact', '🌱', 'Impact']]
    : [['#/sell', '📸', 'List food'], ['#/orders', '🧾', 'Orders'], ['#/impact', '🌱', 'Impact']];
  $('#tabs').innerHTML = tabs.map(([h, i, l]) => `<a href="${h}" class="${location.hash.startsWith(h) ? 'on' : ''}"><span class="ic">${i}</span>${l}</a>`).join('');
  $('#tabs').style.display = tabs.length ? '' : 'none';
}

function connectStream() {
  es?.close();
  es = new EventSource('/api/v1/stream');
  es.addEventListener('listing.new', e => {
    const d = JSON.parse(e.data);
    if (me?.role !== 'buyer') return;
    if (d.match) {
      toast(`🔔 <b>New deal ${d.distance_km} km away</b><br>${esc(d.title)} · ${$$(d.price_cents)} (${d.discount_pct}% off) — <a href="#/deal/${d.id}">view</a>`, 'alert', 9000);
      if ('Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker?.ready.then(r => r.showNotification('Last Call: new deal nearby', { body: `${d.title} · ${$$(d.price_cents)}`, data: { url: `/#/deal/${d.id}` }, icon: '/icon.svg' }))
          .catch(() => new Notification('Last Call: new deal nearby', { body: d.title }));
      }
    }
    if (location.hash.startsWith('#/deals')) route();
  });
  es.addEventListener('listing.updated', e => {
    const d = JSON.parse(e.data);
    if (location.hash.startsWith('#/deals') || location.hash === `#/deal/${d.id}`) route();
  });
  es.addEventListener('reservation.paid', e => {
    const d = JSON.parse(e.data);
    toast(`💳 <b>New order paid: ${$$(d.total_cents)}</b><br>${esc(d.title)} × ${d.qty}. Payout on its way…`, 'good', 7000);
    if (location.hash.startsWith('#/orders')) route();
  });
  es.addEventListener('payout.confirmed', e => {
    const d = JSON.parse(e.data);
    toast(`◎ <b>Solana payout confirmed: ${$$(d.amount_cents)}</b><br><a href="${esc(d.explorer_url)}" target="_blank" rel="noopener">View on explorer</a>${d.source !== 'live' ? ' (devnet mock)' : ''}`, 'good', 9000);
    if (location.hash.startsWith('#/orders')) route();
  });
  es.addEventListener('reservation.picked_up', () => { toast('🎉 Picked up! Thanks for rescuing food.', 'good'); if (location.hash.startsWith('#/order') || location.hash.startsWith('#/me')) route(); });
  es.addEventListener('impact.updated', () => { if (location.hash.startsWith('#/impact')) route(); });
}

// ---------- views ----------
async function viewLogin() {
  const users = await api('/auth/users');
  const card = u => `<div class="who-card" data-id="${u.id}"><div><b>${esc(u.name)}</b><div class="small muted">${u.role === 'seller' ? 'Seller · ' + esc(u.store_name) : 'Buyer'}</div></div><span>→</span></div>`;
  view.innerHTML = `
    <section class="hero"><h1>Tonight's leftovers, tomorrow's breakfast.</h1>
      <p>Stores list surplus food at a discount near closing. You reserve, pay, and pick up. Every pickup counts as meals saved.</p></section>
    <div class="card"><h2>Try it as…</h2><p class="small muted">Demo login. Open a second window as the other role to see alerts and payouts arrive live.</p>
      <h3 style="margin-top:14px">Buyers</h3>${users.filter(u => u.role === 'buyer').map(card).join('')}
      <h3 style="margin-top:14px">Sellers</h3>${users.filter(u => u.role === 'seller').map(card).join('')}
    </div>
    <p class="small muted" style="text-align:center"><a href="#/impact">See community impact →</a> · <a href="#" id="reset">Reset demo data</a></p>`;
  view.querySelectorAll('.who-card').forEach(el => el.onclick = async () => {
    me = await api('/auth/demo-login', { method: 'POST', body: { user_id: el.dataset.id } });
    me = await api('/me'); connectStream();
    location.hash = me.role === 'buyer' ? '#/deals' : '#/sell';
  });
  $('#reset').onclick = async e => { e.preventDefault(); await api('/admin/reset', { method: 'POST' }); toast('Demo data reset', 'good'); };
}

async function viewDeals() {
  const pos = await new Promise(res => {
    if (!navigator.geolocation || !window.useGeo) return res(null);
    navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { timeout: 3000 });
  });
  const q = pos ? `?lat=${pos.latitude}&lng=${pos.longitude}` : '';
  const d = await api(`/listings/nearby${q}`);
  const notifAsk = 'Notification' in window && Notification.permission === 'default';
  view.innerHTML = `
    <div class="row between"><h1>Deals near you</h1><a class="btn ghost" href="#/prefs" style="padding:8px 12px">⚙︎ Preferences</a></div>
    <p class="muted small">Within ${d.radius_km} km · ranked by your preferences, distance and time left. ${pos ? '' : `<a href="#" id="geo">Use my location</a>`}</p>
    ${notifAsk ? `<div class="card row between"><span class="small">Get a push alert when a matching deal is posted.</span><button class="btn amber" id="notif" style="padding:8px 12px">Enable</button></div>` : ''}
    ${d.listings.length ? `<div class="grid">${d.listings.map(l => `
      <article class="card deal" data-id="${l.id}">
        <span class="badge">${l.discount_pct}% off</span>${l.match ? '<span class="badge match">For you</span>' : ''}
        <img src="${esc(l.photo_url || '/demo/pastry.svg')}" alt="">
        <div class="body"><h3>${esc(l.title)}</h3>
          <div class="small muted">${esc(l.store.name)} · ${l.distance_km} km · pick up within ${timeLeft(l.pickup_until)}</div>
          <div class="row between" style="margin-top:8px"><div><span class="price">${$$(l.price_cents)}</span><span class="was">${$$(l.original_cents)}</span></div>
            <span class="small ${l.qty_available <= 1 ? 'timer' : 'muted'}">${l.qty_available} left</span></div>
          <div style="margin-top:6px">${tagPills(l.tags)}</div></div>
      </article>`).join('')}</div>` : `<div class="empty card">No deals nearby right now. We'll alert you when one appears.</div>`}`;
  view.querySelectorAll('.deal').forEach(el => el.onclick = () => location.hash = `#/deal/${el.dataset.id}`);
  $('#geo')?.addEventListener('click', e => { e.preventDefault(); window.useGeo = true; route(); });
  $('#notif')?.addEventListener('click', async () => { await Notification.requestPermission(); route(); });
}

async function viewDeal(id) {
  const l = await api(`/listings/${id}`);
  const live = l.status === 'active' && l.qty_available > 0 && l.pickup_until > Date.now();
  view.innerHTML = `
    <a href="#/deals" class="small">← Deals</a>
    <article class="card deal" style="cursor:default;margin-top:8px"><span class="badge">${l.discount_pct}% off</span>
      <img src="${esc(l.photo_url || '/demo/pastry.svg')}" style="height:220px" alt="">
      <div class="body"><h1>${esc(l.title)}</h1><p>${esc(l.description)}</p>
        <div>${tagPills(l.tags)}</div>
        <p class="small muted">Contains: ${l.items.map(i => `${i.qty} × ${esc(i.name)}`).join(', ')} per box</p>
        <div class="row between"><div><span class="price">${$$(l.price_cents)}</span><span class="was">${$$(l.original_cents)}</span></div>
          <span class="small">${l.qty_available} of ${l.qty_total} left</span></div></div></article>
    <div class="card"><h3>${esc(l.store.name)}</h3><div class="small muted">${esc(l.store.address)} · closes ${esc(l.store.closes_at)}</div>
      <p class="small">Pick up within <b>${timeLeft(l.pickup_until)}</b>. <a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${l.store.lat},${l.store.lng}">Directions</a></p></div>
    ${live ? `<div class="card"><label>Quantity</label><div class="row"><input id="qty" type="number" min="1" max="${l.qty_available}" value="1" style="width:90px">
      <button class="btn amber block" id="reserve">Reserve · hold for 10 min</button></div></div>`
      : `<div class="card empty">${l.status === 'sold_out' || l.qty_available === 0 ? 'Sold out' : 'No longer available'}.</div>`}`;
  $('#reserve')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const r = await api('/reservations', { method: 'POST', body: { listing_id: id, qty: +$('#qty').value } });
      location.hash = `#/checkout/${r.id}`;
    } catch (err) { toast(esc(err.message), 'bad'); e.target.disabled = false; }
  });
}

let ticker;
async function viewCheckout(id) {
  const r = await api(`/reservations/${id}`);
  if (r.status !== 'pending') { location.hash = `#/order/${id}`; return; }
  const key = sessionStorage.getItem(`idem-${id}`) || crypto.randomUUID();
  try { sessionStorage.setItem(`idem-${id}`, key); } catch {}
  view.innerHTML = `
    <h1>Checkout</h1>
    <div class="card"><div class="row between"><div><b>${esc(r.listing.title)}</b><div class="small muted">${esc(r.listing.store.name)} · qty ${r.qty}</div></div>
      <span class="price">${$$(r.total_cents)}</span></div>
      <p class="small">Held for you: <span class="timer" id="hold"></span></p></div>
    <form class="card" id="pay"><div class="row between"><h3 style="margin:0">Pay with card</h3><span class="pill">VISA sandbox</span></div>
      <label>Card number</label><input id="card" inputmode="numeric" autocomplete="cc-number" value="4111 1111 1111 1111">
      <div class="row"><div style="flex:1"><label>Expiry</label><input value="12/28" autocomplete="cc-exp"></div><div style="flex:1"><label>CVC</label><input value="123" autocomplete="cc-csc"></div></div>
      <p class="small muted">Test cards: 4111 1111 1111 1111 approves · 4000 0000 0000 0002 declines.</p>
      <button class="btn block" id="paybtn">Pay ${$$(r.total_cents)}</button>
      <button type="button" class="btn ghost block" id="cancel" style="margin-top:8px">Release hold</button></form>`;
  clearInterval(ticker);
  const tick = () => { const s = Math.max(0, Math.round((r.hold_expires_at - Date.now()) / 1000)); const el = $('#hold'); if (!el) return clearInterval(ticker);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (!s) { clearInterval(ticker); toast('Hold expired', 'bad'); location.hash = `#/deal/${r.listing_id}`; } };
  tick(); ticker = setInterval(tick, 1000);
  $('#pay').onsubmit = async e => {
    e.preventDefault(); const b = $('#paybtn'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Authorising…';
    try {
      await api(`/reservations/${id}/pay`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { payment_token: $('#card').value } });
      toast('Payment approved ✓', 'good'); location.hash = `#/order/${id}`;
    } catch (err) { toast(esc(err.message), 'bad'); b.disabled = false; b.textContent = `Pay ${$$(r.total_cents)}`; }
  };
  $('#cancel').onclick = async () => { await api(`/reservations/${id}/cancel`, { method: 'POST' }); toast('Hold released'); location.hash = '#/deals'; };
}

async function viewOrder(id) {
  const r = await api(`/reservations/${id}`);
  const qr = r.status === 'paid' ? await fetch(`/api/v1/reservations/${id}/qr.svg`).then(x => x.text()) : '';
  view.innerHTML = `
    <a href="#/me" class="small">← My orders</a>
    <div class="card" style="text-align:center;margin-top:8px">
      ${r.status === 'paid' ? `<h1>You're all set 🎉</h1><p class="muted">Show this at the counter</p><div class="qr">${qr}</div>
        <p class="small muted">or tell them the code</p><div class="code">${esc(r.pickup_code)}</div>`
      : r.status === 'picked_up' ? `<h1>Picked up ✓</h1><p class="muted">Thanks for rescuing food tonight.</p>` : `<h1>${esc(r.status)}</h1>`}
    </div>
    <div class="card"><b>${esc(r.listing.title)}</b><div class="small muted">${esc(r.listing.store.name)} · ${esc(r.listing.store.address)}</div>
      <p class="small">Paid ${$$(r.total_cents)} · Visa ${esc(r.payment?.visa_txn_id || '')}</p>
      ${r.status === 'paid' ? `<a class="btn ghost block" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${r.listing.store.lat},${r.listing.store.lng}">Directions</a>` : ''}</div>`;
}

async function viewMe() {
  const rs = await api('/me/reservations');
  view.innerHTML = `<h1>My orders</h1>${rs.length ? rs.map(r => `
    <a class="card row between" href="#/${r.status === 'pending' ? 'checkout' : 'order'}/${r.id}" style="text-decoration:none;color:inherit">
      <div><b>${esc(r.listing.title)}</b><div class="small muted">${esc(r.listing.store.name)} · ${$$(r.total_cents)}</div></div>
      <span class="pill ${r.status === 'paid' ? 'amber' : ''}">${r.status === 'paid' ? 'ready for pickup' : r.status.replace('_', ' ')}</span></a>`).join('')
    : `<div class="card empty">No orders yet. <a href="#/deals">Find a deal →</a></div>`}
    <a href="#/prefs" class="btn ghost block">Alert preferences</a>`;
}

async function viewPrefs() {
  const [{ prefs, source }, stores] = await Promise.all([api('/me/preferences'), api('/stores')]);
  view.innerHTML = `<a href="#/deals" class="small">← Deals</a><h1 style="margin-top:8px">Alert preferences</h1>
    <form class="card" id="pf"><p class="small muted">Remembered for you (Backboard memory · ${esc(source)}) and used to rank deals and target alerts.</p>
      <label>Diet</label><div class="row wrap">${['vegetarian', 'vegan'].map(d => `<label class="row" style="margin:0;color:var(--ink)"><input type="checkbox" name="diet" value="${d}" style="width:auto" ${prefs.diet?.includes(d) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <label>Max price ($)</label><input name="max" type="number" min="0" step="0.5" value="${(prefs.max_price_cents || 0) / 100}">
      <label>Radius (km)</label><input name="radius" type="number" min="0.5" max="50" step="0.5" value="${prefs.radius_km || 5}">
      <label>Favourite stores</label>${stores.map(s => `<label class="row" style="margin:4px 0;color:var(--ink)"><input type="checkbox" name="fav" value="${s.id}" style="width:auto" ${prefs.favourite_stores?.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}
      <button class="btn block" style="margin-top:14px">Save</button></form>`;
  $('#pf').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    await api('/me/preferences', { method: 'PUT', body: { ...prefs, diet: f.getAll('diet'), max_price_cents: Math.round(+f.get('max') * 100), radius_km: +f.get('radius'), favourite_stores: f.getAll('fav') } });
    toast('Preferences saved', 'good'); location.hash = '#/deals';
  };
}

// ---------- seller ----------
async function viewSell() {
  const mine = await api('/store/listings');
  view.innerHTML = `
    <section class="hero"><h1>List tonight's surplus</h1><p>Snap a photo. We'll identify the items, write the listing, and price it for the time left before close (${esc(me.store.closes_at)}).</p></section>
    <div class="card"><label class="drop" for="photo"><div style="font-size:34px">📸</div><b>Take or upload a photo</b><div class="small muted">JPEG or PNG</div></label>
      <input type="file" id="photo" accept="image/*" capture="environment" hidden>
      <p class="small muted" style="margin:12px 0 0">No food handy? Use a demo photo:</p>
      <div class="presets">${['pastry', 'bagel', 'deli', 'sushi'].map(p => `<button data-p="${p}"><img src="/demo/${p}.svg" alt=""><small>${p}</small></button>`).join('')}</div>
      <div id="working" style="display:none;margin-top:14px"></div></div>
    <h2>Your listings</h2>
    ${mine.length ? mine.map(l => `<div class="card row between"><div><b>${esc(l.title)}</b><div class="small muted">${$$(l.price_cents)} · ${l.qty_available}/${l.qty_total} left · ${l.status}${l.status === 'active' ? ' · ' + timeLeft(l.pickup_until) : ''}</div></div>
      ${l.status === 'active' ? `<button class="btn ghost" data-w="${l.id}" style="padding:6px 10px">Withdraw</button>` : `<span class="pill">${l.status}</span>`}</div>`).join('') : '<div class="card empty">Nothing listed yet.</div>'}`;
  const go = async fd => {
    const w = $('#working'); w.style.display = '';
    const steps = ['Identifying items (vision)', 'Writing listing (Gemini)', 'Pricing for time to close'];
    w.innerHTML = steps.map((s, i) => `<div class="step" id="st${i}"><i>${i + 1}</i>${s}</div>`).join('');
    let i = 0; const t = setInterval(() => { $(`#st${i}`)?.classList.add('done'); i = Math.min(i + 1, 2); }, 700);
    try { draft = await api('/listings/draft', { method: 'POST', body: fd }); clearInterval(t); location.hash = '#/review'; }
    catch (err) { clearInterval(t); w.style.display = 'none'; toast(esc(err.message), 'bad'); }
  };
  $('#photo').onchange = e => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('photo', f); go(fd); };
  view.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const fd = new FormData(); fd.append('preset', b.dataset.p); go(fd); });
  view.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => { await api(`/listings/${b.dataset.w}`, { method: 'PATCH', body: { status: 'withdrawn' } }); route(); });
}

function viewReview() {
  if (!draft) { location.hash = '#/sell'; return; }
  const d = draft; const localUntil = new Date(new Date(d.pickup_until).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  view.innerHTML = `
    <a href="#/sell" class="small">← Retake</a><h1 style="margin-top:8px">Review listing</h1>
    <div class="ai">✨ Vision: <b>${esc(d.source.vision)}</b> · Listing: <b>${esc(d.source.llm)}</b> · ${d.minutes_to_close} min to close → discount clamped to <b>${d.discount_pct}%</b>${d.proposed_discount != null && d.proposed_discount !== d.discount_pct ? ` (model proposed ${esc(d.proposed_discount)}%)` : ''}</div>
    <form class="card" id="rv" style="margin-top:12px">
      <img src="${esc(d.photo_url)}" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px" alt="">
      <p class="small muted">Detected: ${d.items.map(i => `${i.qty} × ${esc(i.name)} <span class="muted">(${Math.round(i.confidence * 100)}%)</span>`).join(', ')}</p>
      <label>Title</label><input name="title" maxlength="80" value="${esc(d.title)}">
      <label>Description</label><textarea name="description" rows="3" maxlength="240">${esc(d.description)}</textarea>
      <div>${tagPills(d.tags)}</div>
      <div class="row"><div style="flex:1"><label>Original value ($)</label><input name="orig" type="number" step="0.01" value="${(d.original_cents / 100).toFixed(2)}"></div>
        <div style="flex:1"><label>Your price ($)</label><input name="price" type="number" step="0.01" value="${(d.price_cents / 100).toFixed(2)}"></div></div>
      <div class="row"><div style="flex:1"><label>Boxes available</label><input name="qty" type="number" min="1" value="1"></div>
        <div style="flex:1"><label>Pickup until</label><input name="until" type="datetime-local" value="${localUntil}"></div></div>
      <button class="btn amber block" style="margin-top:16px">Publish & alert nearby buyers</button></form>`;
  $('#rv').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      await api('/listings', { method: 'POST', body: { title: f.get('title'), description: f.get('description'), items: d.items, tags: d.tags, photo_url: d.photo_url,
        original_cents: Math.round(+f.get('orig') * 100), price_cents: Math.round(+f.get('price') * 100), qty_total: +f.get('qty'),
        pickup_until: new Date(f.get('until')).toISOString(), source: d.source } });
      draft = null; toast('Listing live — nearby buyers alerted 📣', 'good'); location.hash = '#/orders';
    } catch (err) { toast(esc(err.message), 'bad'); }
  };
}

async function viewOrders() {
  const os = await api('/orders');
  view.innerHTML = `<h1>Orders</h1>
    <form class="card" id="pk"><h3>Confirm pickup</h3><p class="small muted">Scan the buyer's QR or type their 6-character code.</p>
      <div class="row"><input id="code" placeholder="e.g. K7Q2MX" autocapitalize="characters" style="text-transform:uppercase">
      <button class="btn">Confirm</button></div>${'BarcodeDetector' in window ? '<button type="button" class="btn ghost block" id="scan" style="margin-top:8px">📷 Scan QR</button><video id="cam" playsinline style="width:100%;display:none;border-radius:12px;margin-top:8px"></video>' : ''}</form>
    ${os.length ? `<div class="card"><table><tr><th>Order</th><th>Status</th><th>Payout</th></tr>${os.map(o => `<tr>
      <td><b>${esc(o.listing.title)}</b><div class="small muted">${esc(o.buyer)} · ×${o.qty} · ${$$(o.total_cents)}</div></td>
      <td><span class="pill ${o.status === 'paid' ? 'amber' : ''}">${o.status.replace('_', ' ')}</span></td>
      <td class="small">${o.payment ? (o.payment.payout_status === 'confirmed' ? `${$$(o.payment.payout_cents)} <a href="${esc(o.payment.explorer_url)}" target="_blank" rel="noopener">◎ tx</a>` : 'queued…') : '—'}</td></tr>`).join('')}</table></div>`
    : '<div class="card empty">No orders yet. They appear here the moment a buyer pays.</div>'}
    <div class="card row between"><span class="small">Share your store's impact</span><a class="btn ghost" href="/api/v1/impact/card/${me.store_id}.svg" target="_blank" id="share" style="padding:8px 12px">Impact card</a></div>`;
  const confirm = async c => {
    try { const r = await api('/pickup', { method: 'POST', body: { code: c } }); toast(`✓ Picked up — ${r.meals_saved} meals saved`, 'good'); route(); }
    catch (err) { toast(esc(err.message), 'bad'); }
  };
  $('#pk').onsubmit = e => { e.preventDefault(); confirm($('#code').value); };
  $('#scan')?.addEventListener('click', async () => {
    const v = $('#cam'); v.style.display = '';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).catch(() => null);
    if (!stream) return toast('Camera unavailable', 'bad');
    v.srcObject = stream; await v.play(); const det = new BarcodeDetector({ formats: ['qr_code'] });
    const loop = async () => { const c = await det.detect(v).catch(() => []);
      if (c[0]) { stream.getTracks().forEach(t => t.stop()); return confirm(c[0].rawValue); }
      if (document.body.contains(v)) requestAnimationFrame(loop); else stream.getTracks().forEach(t => t.stop()); };
    loop();
  });
  $('#share').onclick = async e => {
    const url = new URL(`/api/v1/impact/card/${me.store_id}.svg`, location.href).href;
    if (navigator.share) { e.preventDefault(); navigator.share({ title: 'Our food-rescue impact', url }).catch(() => {}); }
  };
}

async function viewImpact() {
  const d = await api('/impact/summary');
  const max = Math.max(1, ...d.daily.map(x => x.meals));
  view.innerHTML = `<h1>Community impact</h1>
    <div class="stats">
      <div class="stat"><b>${d.totals.meals}</b><span class="small muted">meals saved</span></div>
      <div class="stat"><b>$${Math.round(d.totals.cents / 100)}</b><span class="small muted">recovered by stores</span></div>
      <div class="stat"><b>${d.totals.kg}</b><span class="small muted">kg kept from the bin*</span></div>
      <div class="stat"><b>${d.totals.co2e}</b><span class="small muted">kg CO₂e avoided*</span></div></div>
    <div class="card" style="margin-top:14px;padding-bottom:30px"><h3>Meals saved per day</h3>
      <div class="bars">${d.daily.map(x => `<div style="height:${(x.meals / max) * 100}%" title="${x.meals} meals"><span>${x.day.slice(5)}</span></div>`).join('')}</div></div>
    <div class="card"><h3>By store</h3><table>${d.by_store.map(s => `<tr><td>${esc(s.name)}</td><td>${s.meals} meals</td><td>$${Math.round(s.cents / 100)}</td>
      <td><a href="/api/v1/impact/card/${s.id}.svg" target="_blank">card</a></td></tr>`).join('')}</table></div>
    <p class="small muted">* Estimates: ${d.assumptions.kg_per_meal} kg per item, ${d.assumptions.co2e_per_kg} kg CO₂e per kg of food. Updates live on every pickup.</p>`;
}

// ---------- router ----------
async function route() {
  const h = location.hash || '#/';
  const [, page, id] = h.split('/');
  if (!me) { try { me = await api('/me'); connectStream(); } catch { me = null; } }
  renderShell();
  try {
    if (page === 'impact') return await viewImpact();
    if (!me) return await viewLogin();
    if (me.role === 'buyer') {
      if (page === 'deal') return await viewDeal(id);
      if (page === 'checkout') return await viewCheckout(id);
      if (page === 'order') return await viewOrder(id);
      if (page === 'me') return await viewMe();
      if (page === 'prefs') return await viewPrefs();
      if (page !== 'deals') return (location.hash = '#/deals');
      return await viewDeals();
    }
    if (page === 'review') return viewReview();
    if (page === 'orders') return await viewOrders();
    if (page !== 'sell') return (location.hash = '#/sell');
    return await viewSell();
  } catch (e) {
    if (e.status === 401) { me = null; return viewLogin(); }
    view.innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
