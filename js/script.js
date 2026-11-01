/* Groco storefront — talks to server.js (see /api routes) */
// same-origin API, except when the page is opened through VS Code Live Server (ports 5500/5501)
const API_HOST = (location.protocol.startsWith('http') && !['5500', '5501'].includes(location.port)) ? '/api' : 'http://localhost:3000/api';
const ORIGIN = API_HOST.startsWith('/') ? '' : API_HOST.replace(/\/api$/, '');
const src = u => (u && u.startsWith('/')) ? ORIGIN + u : u;
const FALLBACK_IMG = 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=300&auto=format&fit=crop&q=60';
const TRACK_STEPS = ['Placed', 'Picking', 'Packed', 'Dispatched', 'Delivered'];
const STEP_LABEL = { Placed: 'Order placed', Picking: 'Being picked at the store', Packed: 'Packed, waiting for rider', Dispatched: 'Out for delivery', Delivered: 'Delivered', Cancelled: 'Cancelled' };
const $ = s => document.querySelector(s);

// DOM
const overlayBackdrop = $('#overlay-backdrop');
const shoppingCart = $('#shopping-cart');
const loginForm = $('#login-form');
const checkoutModal = $('#checkout-modal');
const trackingModal = $('#tracking-modal');
const toast = $('#toast-notify');
const categoriesPickerModal = $('#categories-picker-modal');
const homeMainView = $('#home-main-view');
const categoryPageView = $('#category-page-view');
const searchModal = $('#search-modal');
const detailModal = $('#product-detail-modal');

// State
let liveProducts = [];
let categories = [];
let catalogSig = '';
let cart = JSON.parse(localStorage.getItem('groco_cart') || '[]');
let coupon = null;                       // { code, discount }
let trackTimer = null, trackingOrderId = null, es = null, addresses = [];
let activeCat = null, activeSub = 'All', activeBrand = 'All';
let sel = {};                                   // product_id -> chosen size (barcode)
let trackMap = null, riderMarker = null, addrPin = null, ordersShown = 8;

// ---------- helpers ----------
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '₹' + (Math.round(Number(n) * 100) / 100);
const getUser = () => JSON.parse(localStorage.getItem('groco_cust_user') || 'null');
function authHeaders() {
    const t = localStorage.getItem('groco_cust_token');
    return t ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t } : { 'Content-Type': 'application/json' };
}
function showToast(msg) {
    if (!toast) return;
    toast.innerText = msg; toast.classList.add('show');
    clearTimeout(showToast.t); showToast.t = setTimeout(() => toast.classList.remove('show'), 2400);
}
const prod = bc => liveProducts.find(p => p.barcode === bc);
const stockOf = bc => { const p = prod(bc); return p ? Number(p.stock ?? p.quantity ?? 0) : 0; };
const catOf = id => categories.find(c => c.id === id);
function imgTag(p, cls = '') {
    const tile = src('/api/tile/' + p.barcode + '.svg');
    return `<img ${cls ? `class="${cls}"` : ''} src="${esc(src(p.image) || tile)}" alt="${esc(p.title)}" loading="lazy" data-fb="${esc(tile)}" onerror="imgFail(this)">`;
}
function imgFail(el) {
    if (!el.dataset.tried) { el.dataset.tried = '1'; el.src = el.dataset.fb || FALLBACK_IMG; }
    else { el.onerror = null; el.src = FALLBACK_IMG; }
}
function closeAll() {
    [loginForm, shoppingCart, checkoutModal, categoriesPickerModal, searchModal, detailModal].forEach(e => e && e.classList.remove('active'));
    closeTracking(true);
    overlayBackdrop.classList.remove('active');
}

// ---------- catalog ----------
async function loadCatalog() {
    try {
        const [pr, cr] = await Promise.all([fetch(`${API_HOST}/products`), categories.length ? null : fetch(`${API_HOST}/categories`)]);
        if (!pr.ok) throw new Error('HTTP ' + pr.status);
        const products = await pr.json();
        if (cr && cr.ok) { categories = await cr.json(); renderCategoryPills(); renderPicker(); }
        const sig = JSON.stringify(products);
        if (sig === catalogSig) return;                       // nothing changed → keep scroll positions
        catalogSig = sig; liveProducts = products;
        syncCartWithCatalog();
        renderAll();
    } catch (e) {
        console.error('Catalog load failed:', e);
        if (!liveProducts.length) showToast('Cannot reach server. Run: node server.js');
    }
}
function syncCartWithCatalog() {
    cart = cart.filter(c => prod(c.barcode)).map(c => {
        const p = prod(c.barcode), max = stockOf(c.barcode);
        return { ...c, title: p.title, variant: p.variant, price: p.price, oldPrice: p.oldPrice, image: p.image, qty: Math.min(c.qty, max) };
    }).filter(c => c.qty > 0);
    updateCartUI(true);
}
function renderAll() {
    renderStorefront();
    if (categoryPageView.style.display !== 'none') renderCategoryPage();
    if (searchModal.classList.contains('active')) renderSearch();
}

// ---------- grouped product cards (one card per product, sizes inside) ----------
function variantsOf(pid) { return liveProducts.filter(p => p.product_id === pid); }
function chosen(pid, preferBc) {
    const vs = variantsOf(pid);
    if (sel[pid] && vs.some(v => v.barcode === sel[pid])) return prod(sel[pid]);
    if (preferBc && vs.some(v => v.barcode === preferBc)) return prod(preferBc);
    return vs.find(v => stockOf(v.barcode) > 0) || vs[0];
}
function groupsFrom(items, limit) {                    // keep order, one entry per product_id
    const seen = new Set(), out = [];
    for (const p of items) { if (seen.has(p.product_id)) continue; seen.add(p.product_id); out.push(p.product_id); if (limit && out.length >= limit) break; }
    return out;
}
function productCard(pid) {
    const vs = variantsOf(pid); if (!vs.length) return '';
    const p = chosen(pid), inCart = cart.find(c => c.barcode === p.barcode), left = stockOf(p.barcode), out = left <= 0;
    const off = p.oldPrice > p.price ? Math.round((1 - p.price / p.oldPrice) * 100) : 0;
    return `
    <div class="g-card">
        ${off ? `<span class="g-off">${off}% OFF</span>` : ''}
        <div class="g-img" data-act="open" data-bc="${esc(p.barcode)}">${imgTag(p)}</div>
        <div class="g-brand">${esc(p.brand || 'Groco')}</div>
        <div class="g-title" data-act="open" data-bc="${esc(p.barcode)}" title="${esc(p.title)}">${esc(p.title)}</div>
        <div class="g-sizes">${vs.length > 1 ? vs.map(v => `<span class="g-size ${v.barcode === p.barcode ? 'on' : ''} ${stockOf(v.barcode) <= 0 ? 'out' : ''}" data-act="size" data-pid="${esc(pid)}" data-bc="${esc(v.barcode)}">${esc(v.variant)}</span>`).join('')
            : `<span class="g-size on" style="cursor:default">${esc(p.variant)}</span>`}</div>
        <div class="g-note ${out ? 'red' : ''}">${out ? 'Out of stock' : left <= 5 ? `Only ${left} left` : ''}</div>
        <div class="g-bottom">
            <div class="g-price"><b>${money(p.price)}</b>${p.oldPrice > p.price ? `<s>${money(p.oldPrice)}</s>` : ''}</div>
            ${out ? '<button class="g-add" disabled>Sold out</button>'
            : inCart ? `<div class="g-step"><button data-act="dec" data-bc="${esc(p.barcode)}">−</button><span>${inCart.qty}</span><button data-act="inc" data-bc="${esc(p.barcode)}">+</button></div>`
            : `<button class="g-add" data-act="add" data-bc="${esc(p.barcode)}">ADD</button>`}
        </div>
    </div>`;
}
document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const bc = el.dataset.bc;
    switch (el.dataset.act) {
        case 'add': addToCart(bc); break;
        case 'inc': changeQty(bc, +1); break;
        case 'dec': changeQty(bc, -1); break;
        case 'open': openProductDetail(bc); break;
        case 'size': sel[el.dataset.pid] = bc; refreshViews(); break;
        case 'track': openTracking(el.dataset.id); break;
        case 'cancel': cancelMyOrder(el.dataset.id); break;
        case 'paynow': payNow(el.dataset.id); break;
        case 'issue': reportIssue(el.dataset.id); break;
        case 'rate': rateRider(el.dataset.id, Number(el.dataset.stars)); break;
        case 'deladdr': e.preventDefault(); deleteAddress(el.dataset.id); break;
        case 'cat': closeAll(); openCategoryPage(el.dataset.cat); break;
    }
});

// ---------- home shelves ----------
function refreshViews() {
    renderStorefront();
    if (categoryPageView.style.display !== 'none') renderCategoryPage();
}
function renderStorefront() {
    const shelves = [
        ['#shelf-bestsellers', p => p.isBestSeller],
        ['#shelf-fresh-picks', p => p.isFreshPick || p.category === 'vegetables' || p.category === 'fruits'],
        ['#shelf-daily-essentials', p => p.isDailyEssential],
        ['#shelf-under-99', p => p.price < 99],
        ['#shelf-under-199', p => p.price >= 99 && p.price < 199]
    ];
    const keep = new Map();
    const draw = (box, pids) => {
        const x = box.scrollLeft;
        box.innerHTML = pids.length ? pids.map(productCard).join('') : '<p style="padding:2rem;color:#94a3b8;font-size:1.3rem;">Nothing here yet</p>';
        box.scrollLeft = x;
    };
    shelves.forEach(([sel2, test]) => { const box = $(sel2); if (box) draw(box, groupsFrom(liveProducts.filter(test), 14)); });
    // New arrivals = products an admin/picker added after the first catalog load
    const times = liveProducts.map(p => String(p.created_at)).sort(), first = times[0] ? new Date(times[0].replace(' ', 'T')).getTime() : 0;
    const fresh = liveProducts.filter(p => new Date(String(p.created_at).replace(' ', 'T')).getTime() - first > 10 * 60 * 1000).reverse();
    const sec = $('#shelf-new-sec');
    if (sec) { sec.style.display = fresh.length ? 'block' : 'none'; if (fresh.length) draw($('#shelf-new'), groupsFrom(fresh, 14)); }
}

// ---------- categories: home pills, picker, category page ----------
const CAT_TINTS = ['#e0f5e9', '#fff1e0', '#e6efff', '#fde8ef', '#f1ebff', '#e0f6f8', '#fff7cc', '#eaf6dd'];
function catCard(c, i) {
    return `<div class="g-catcard" style="background:${CAT_TINTS[i % CAT_TINTS.length]}" data-act="cat" data-cat="${esc(c.id)}">
        <div class="g-catemoji">${c.emoji || '🛒'}</div><h4>${esc(c.name)}</h4></div>`;
}
function renderCategoryPills() { const g = $('#category-pills-grid'); if (g) g.innerHTML = categories.map(catCard).join(''); }
function renderPicker() { const g = $('#picker-grid'); if (g) g.innerHTML = categories.map(catCard).join(''); }
function openCategoriesPickerModal() {
    closeAll();
    categoriesPickerModal.classList.add('active'); overlayBackdrop.classList.add('active');
}
function openCategoryPage(catId) {
    activeCat = catId; activeSub = 'All'; activeBrand = 'All';
    homeMainView.style.display = 'none';
    categoryPageView.style.display = 'block';
    renderCategoryPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
function backToHome() {
    categoryPageView.style.display = 'none';
    homeMainView.style.display = 'block';
    activeCat = null;
}
function renderCategoryPage() {
    const cat = catOf(activeCat); if (!cat) return;
    const inCat = liveProducts.filter(p => p.category === activeCat);
    const subs = [...new Set([...(cat.subcategories || []), ...inCat.map(p => p.subcategory).filter(Boolean)])].filter(s => inCat.some(p => p.subcategory === s));
    if (activeSub !== 'All' && !subs.includes(activeSub)) activeSub = 'All';
    const bySub = activeSub === 'All' ? inCat : inCat.filter(p => p.subcategory === activeSub);
    const brands = [...new Set(bySub.map(p => p.brand).filter(Boolean))].sort();
    if (activeBrand !== 'All' && !brands.includes(activeBrand)) activeBrand = 'All';
    const list = activeBrand === 'All' ? bySub : bySub.filter(p => p.brand === activeBrand);
    const pids = groupsFrom(list);
    $('#cat-page-heading').innerText = cat.name;
    $('#cat-page-count').innerText = `${pids.length} product${pids.length === 1 ? '' : 's'}`;
    $('#subcat-sidebar').innerHTML = ['All', ...subs].map(sb => `
        <div class="subcat-side-item ${sb === activeSub ? 'active' : ''}" data-sub="${esc(sb)}">${esc(sb)}
        <small style="opacity:.6"> (${groupsFrom(sb === 'All' ? inCat : inCat.filter(p => p.subcategory === sb)).length})</small></div>`).join('');
    $('#brand-chips-filter').innerHTML = brands.length > 1 ? ['All', ...brands].map(b => `<span class="brand-chip ${b === activeBrand ? 'active' : ''}" data-brand="${esc(b)}">${esc(b)}</span>`).join('') : '';
    $('#category-page-grid').innerHTML = pids.length ? pids.map(productCard).join('') : '<p style="padding:3rem;color:#94a3b8;font-size:1.4rem;">No products in this section yet.</p>';
}
$('#subcat-sidebar').addEventListener('click', e => { const el = e.target.closest('[data-sub]'); if (el) { activeSub = el.dataset.sub; activeBrand = 'All'; renderCategoryPage(); } });
$('#brand-chips-filter').addEventListener('click', e => { const el = e.target.closest('[data-brand]'); if (el) { activeBrand = el.dataset.brand; renderCategoryPage(); } });
$('#back-to-home-btn').onclick = backToHome;
$('#open-categories-modal-btn').onclick = openCategoriesPickerModal;
$('#close-picker-btn').onclick = closeAll;
if ($('#menu-btn')) $('#menu-btn').onclick = openCategoriesPickerModal;

// ---------- search ----------
const getRecent = () => JSON.parse(localStorage.getItem('groco_recent_search') || '[]');
function openSearch() {
    closeAll(); searchModal.classList.add('active'); overlayBackdrop.classList.add('active');
    renderSearch(); setTimeout(() => $('#search-box').focus(), 50);
}
function renderSearch() {
    const q = $('#search-box').value.trim().toLowerCase();
    const recent = getRecent();
    $('#recent-search-section').style.display = recent.length && !q ? 'block' : 'none';
    $('#recent-chips').innerHTML = recent.map(r => `<span class="recent-chip" data-q="${esc(r)}"><i class="fa fa-history"></i> ${esc(r)}</span>`).join('');
    const found = q ? liveProducts.filter(p => [p.title, p.brand, p.category, p.subcategory, p.variant].join(' ').toLowerCase().includes(q)) : liveProducts.filter(p => p.isBestSeller);
    const pids = groupsFrom(found, 20);
    $('#suggestions-list').innerHTML = pids.length ? pids.map(pid => {
        const vs = variantsOf(pid), p = chosen(pid), min = Math.min(...vs.map(v => v.price));
        return `<div class="suggestion-row" data-act="open" data-bc="${esc(p.barcode)}">
            ${imgTag(p)}
            <div class="suggestion-info"><div class="sug-title">${esc(p.title)}</div><div class="sug-cat">${esc((catOf(p.category) || {}).name || p.category)} · ${vs.length > 1 ? vs.length + ' sizes' : esc(p.variant)}</div></div>
            <div class="suggestion-price">${vs.length > 1 ? 'from ' : ''}${money(min)}</div>
        </div>`; }).join('') : '<p style="padding:1.5rem;color:#94a3b8;font-size:1.3rem;">No matching items</p>';
}
function saveRecent(q) {
    q = q.trim(); if (q.length < 2) return;
    localStorage.setItem('groco_recent_search', JSON.stringify([q, ...getRecent().filter(x => x !== q)].slice(0, 6)));
}
$('#header-search-trigger').onclick = openSearch;
$('#search-box').addEventListener('input', renderSearch);
$('#search-box').addEventListener('keydown', e => { if (e.key === 'Enter') { saveRecent(e.target.value); renderSearch(); } });
$('#close-search-btn').onclick = closeAll;
$('#clear-history-btn').onclick = () => { localStorage.removeItem('groco_recent_search'); renderSearch(); };
$('#recent-chips').addEventListener('click', e => { const el = e.target.closest('[data-q]'); if (el) { $('#search-box').value = el.dataset.q; renderSearch(); } });

// ---------- product detail ----------
function openProductDetail(bc) {
    const p = prod(bc); if (!p) return;
    saveRecent($('#search-box').value);
    const siblings = liveProducts.filter(x => x.product_id === p.product_id);
    const inCart = cart.find(c => c.barcode === p.barcode);
    const out = stockOf(bc) <= 0;
    const off = p.oldPrice > p.price ? Math.round((1 - p.price / p.oldPrice) * 100) : 0;
    $('#product-detail-content').innerHTML = `
        <span class="modal-close-btn" id="detail-close">&times;</span>
        <div class="modal-product-layout">
            <div class="modal-img-wrap">${imgTag(p)}</div>
            <div>
                <span class="badge fresh">${esc(p.brand)}</span>
                <h2 class="modal-title">${esc(p.title)}</h2>
                <div class="modal-specs">${esc((catOf(p.category) || {}).name || p.category)} · ${esc(p.subcategory || '')}${p.rating ? ' · ⭐ ' + esc(p.rating) : ''}</div>
                <div class="variant-chips-row">${siblings.map(s => `<span class="variant-pill ${s.barcode === bc ? 'active' : ''}" data-act="open" data-bc="${esc(s.barcode)}">${esc(s.variant)}</span>`).join('')}</div>
                <div class="modal-price-line"><span class="price">${money(p.price)}</span>${off ? `<span class="old-price">${money(p.oldPrice)}</span><span class="discount-badge">${off}% OFF</span>` : ''}</div>
                <p class="modal-desc">${esc(p.description || 'Fresh and quality checked.')}</p>
                <div class="modal-actions">${out ? '<button class="btn" disabled style="opacity:.5">Out of stock</button>'
                    : inCart ? `<div class="card-stepper" style="flex:1;justify-content:center"><button data-act="dec" data-bc="${esc(bc)}">-</button><span>${inCart.qty}</span><button data-act="inc" data-bc="${esc(bc)}">+</button></div>`
                    : `<button class="btn" data-act="add" data-bc="${esc(bc)}">Add to cart</button>`}</div>
            </div>
        </div>`;
    searchModal.classList.remove('active');
    detailModal.classList.add('active'); overlayBackdrop.classList.add('active');
    $('#detail-close').onclick = closeAll;
    detailModal.dataset.bc = bc;
}
detailModal.addEventListener('click', e => { if (e.target === detailModal) closeAll(); });

// ---------- cart ----------
function addToCart(bc) {
    const p = prod(bc); if (!p) return;
    if (stockOf(bc) <= 0) return showToast('Out of stock');
    const ex = cart.find(c => c.barcode === bc);
    if (ex) { if (ex.qty >= stockOf(bc)) return showToast('Only ' + stockOf(bc) + ' in stock'); ex.qty++; }
    else cart.push({ barcode: p.barcode, title: p.title, variant: p.variant, price: p.price, oldPrice: p.oldPrice, image: p.image, qty: 1 });
    afterCartChange(); showToast(`${p.title} added!`);
}
function changeQty(bc, d) {
    const i = cart.findIndex(c => c.barcode === bc); if (i < 0) return;
    if (d > 0) { if (cart[i].qty >= stockOf(bc)) return showToast('Only ' + stockOf(bc) + ' in stock'); cart[i].qty++; }
    else if (--cart[i].qty <= 0) cart.splice(i, 1);
    afterCartChange();
}
function afterCartChange() {
    updateCartUI(); refreshViews();
    if (detailModal.classList.contains('active')) openProductDetail(detailModal.dataset.bc);
}
function totals() {
    const sell = cart.reduce((t, c) => t + c.price * c.qty, 0);
    const mrp = cart.reduce((t, c) => t + (c.oldPrice || c.price) * c.qty, 0);
    if (coupon && sell < 299) coupon = null;
    const cd = coupon ? coupon.discount : 0;
    const fee = (cart.length && shop) ? (sell >= shop.free_delivery_above ? 0 : shop.delivery_fee) : 0;
    return { sell, mrp, cd, fee, pay: sell - cd + fee, savings: Math.max(0, mrp - sell) + cd };
}
function updateCartUI(skipSave) {
    localStorage.setItem('groco_cart', JSON.stringify(cart));
    const t = totals();
    const box = $('.cart-items-container');
    box.innerHTML = cart.length ? cart.map(c => `
        <div class="cart-item">
            <img src="${esc(src(c.image) || src('/api/tile/' + c.barcode + '.svg'))}" alt="${esc(c.title)}" onerror="this.onerror=null;this.src='${src('/api/tile/' + c.barcode + '.svg')}'">
            <div class="cart-item-info"><h4>${esc(c.title)}</h4><span class="item-unit">${esc(c.variant)}</span><span class="item-price">${money(c.price * c.qty)}</span></div>
            <div class="qty-controller"><button class="qty-btn" data-act="dec" data-bc="${esc(c.barcode)}">-</button><span class="qty-amount">${c.qty}</span><button class="qty-btn" data-act="inc" data-bc="${esc(c.barcode)}">+</button></div>
        </div>`).join('')
        : `<div style="text-align:center;padding:4rem 1rem;color:#64748b;"><i class="fa fa-shopping-basket" style="font-size:3rem;color:#cbd5e1;margin-bottom:1rem;"></i><p>Your basket is empty</p></div>`;
    $('#cart-subtotal').innerText = money(t.sell);
    $('#cart-savings').innerText = '-' + money(t.savings);
    $('#cart-total-val').innerText = money(t.pay);
    if (shop) {
        $('#cart-fee').innerText = !cart.length ? '-' : t.fee ? money(t.fee) : 'FREE';
        $('#cart-note').innerText = !cart.length ? '' : t.sell < shop.min_order ? `Minimum order is ₹${shop.min_order}. Add ₹${Math.ceil(shop.min_order - t.sell)} more.`
            : t.fee ? `Add ₹${Math.ceil(shop.free_delivery_above - t.sell)} more for free delivery` : '';
        if ($('#inv-fee')) $('#inv-fee').innerText = t.fee ? money(t.fee) : 'Free';
    }
    $('#cart-count').innerText = cart.reduce((n, c) => n + c.qty, 0);
    $('#cart-item-types').innerText = cart.length;
    if ($('#inv-mrp')) { $('#inv-mrp').innerText = money(t.mrp); $('#inv-discount').innerText = '-' + money(t.savings); $('#inv-total').innerText = money(t.pay); }
    const pm = $('#promo-message');
    if (pm) { pm.innerText = coupon ? `${coupon.code} applied: -${money(coupon.discount)}` : ''; pm.style.color = '#00b761'; }
}
$('#apply-promo-btn').onclick = async () => {
    const code = $('#promo-input').value.trim();
    if (!code) return;
    const t = totals();
    try {
        const r = await fetch(`${API_HOST}/coupon/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, subtotal: t.sell }) });
        const d = await r.json();
        if (r.ok) { coupon = { code: code.toUpperCase(), discount: d.discount }; updateCartUI(); }
        else { coupon = null; updateCartUI(); const pm = $('#promo-message'); pm.innerText = d.message || 'Invalid code'; pm.style.color = '#ef4444'; }
    } catch (e) { showToast('Server offline'); }
};

// ---------- checkout ----------
$('#proceed-checkout-btn').onclick = () => {
    if (!cart.length) return showToast('Your cart is empty!');
    if (shop && totals().sell < shop.min_order) return showToast(`Minimum order is ₹${shop.min_order}`);
    if (!localStorage.getItem('groco_cust_token')) {
        shoppingCart.classList.remove('active'); loginForm.classList.add('active');
        return showToast('Please sign in to place your order');
    }
    shoppingCart.classList.remove('active');
    overlayBackdrop.classList.add('active'); checkoutModal.classList.add('active');
    loadAddresses(); loadShopSettings().then(renderSlots);
};
$('#close-checkout-btn').onclick = closeAll;

$('#confirm-order-btn').onclick = async () => {
    const user = getUser();
    if (!cart.length) return showToast('Cart is empty!');
    if (!user) return showToast('Please sign in first');
    const a = $('input[name="delivery_address"]:checked');
    if (!a) return alert('Please add and select a delivery address');
    const pay = $('input[name="payment_mode"]:checked');
    const btn = $('#confirm-order-btn');
    btn.disabled = true; btn.innerText = 'Placing order...';
    try {
        const res = await fetch(`${API_HOST}/orders/place`, {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ address_id: Number(a.value), payment_mode: pay ? pay.value : 'ONLINE', slot: $('#slot-select').value, coupon: coupon ? coupon.code : '',
                items: cart.map(c => ({ barcode: c.barcode, title: c.title, qty: c.qty })) })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            cart = []; coupon = null; updateCartUI();
            checkoutModal.classList.remove('active');
            catalogSig = ''; await loadCatalog();
            loadCustomerOrders();
            if (data.payment) await payOnline(data.orderId, data.payment);
            openTracking(data.orderId);
        } else if (res.status === 401) { handleCustomerLogout(); closeAll(); loginForm.classList.add('active'); showToast('Session expired — sign in again'); }
        else { alert(data.message || 'Order failed'); catalogSig = ''; loadCatalog(); }
    } catch (e) { alert('Server offline. Start node server.js'); }
    finally { btn.disabled = false; btn.innerText = 'Confirm Order'; }
};

// ---------- store rules (delivery fee, minimum order, slots) ----------
async function loadShopSettings() {
    try { const r = await fetch(`${API_HOST}/settings/public`); if (r.ok) { shop = await r.json(); updateCartUI(); } } catch (e) {}
    return shop;
}
function renderSlots() {
    if (!shop) return;
    const sel = $('#slot-select'), opts = [];
    if (shop.is_open) opts.push('<option value="ASAP">Deliver now (about 10-20 min)</option>');
    shop.slots.forEach(s => opts.push(`<option value="${esc(s.value)}">${esc(s.label)}</option>`));
    sel.innerHTML = opts.join('') || '<option value="">Store is closed</option>';
    $('#slot-note').innerText = shop.is_open ? '' : `Store is closed now (open ${shop.store_open} to ${shop.store_close}). Choose a slot for later.`;
    $('#pay-note').innerText = shop.payment === 'demo' ? '(demo: no real money)' : '';
}

// ---------- online payment ----------
function gsheet(html) { $('#g-sheet').innerHTML = html; $('#g-sheet-bg').classList.add('open'); }
function closeSheet() { $('#g-sheet-bg').classList.remove('open'); }
function loadRzp() {
    return new Promise((res, rej) => {
        if (window.Razorpay) return res();
        const sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js'; sc.onload = res;
        sc.onerror = () => rej(new Error('Could not open the payment window. Check your internet and try again from My Orders.')); document.head.appendChild(sc);
    });
}
async function verifyPayment(orderId, extra) {
    const r = await fetch(`${API_HOST}/payments/verify`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ order_id: orderId, ...extra }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'Payment failed');
    showToast('Payment received ✓');
}
function payOnline(orderId, p) {
    if (p.provider === 'demo') return new Promise(resolve => {
        gsheet(`<h3>Demo payment</h3><p>This store has no payment gateway connected yet, so this only <b>simulates</b> paying ₹${(p.amount / 100).toFixed(2)}. Nobody is charged.</p>
            <div style="display:flex;gap:1rem;margin-top:1.6rem;"><button class="g-actbtn" id="dp-later">Pay later</button><button class="g-actbtn fill" id="dp-pay">Pay ₹${(p.amount / 100).toFixed(2)} (demo)</button></div>`);
        $('#dp-later').onclick = () => { closeSheet(); showToast('Not paid yet. Finish within 15 minutes from My Orders.'); resolve(); };
        $('#dp-pay').onclick = async () => { try { await verifyPayment(orderId, { demo: true }); } catch (e) { alert(e.message); } closeSheet(); resolve(); };
    });
    return loadRzp().then(() => new Promise(resolve => {
        new Razorpay({ key: p.key, amount: p.amount, currency: 'INR', name: (shop && shop.store_name) || 'Groco', description: 'Order ' + orderId, order_id: p.order_id,
            prefill: { name: p.name, email: p.email, contact: p.phone }, theme: { color: '#00b761' },
            handler: async r => { try { await verifyPayment(orderId, { razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature }); } catch (e) { alert(e.message); } resolve(); },
            modal: { ondismiss: () => { showToast('Payment not completed. Finish within 15 minutes from My Orders.'); resolve(); } } }).open();
    })).catch(e => alert(e.message));
}
async function payNow(orderId) {
    const r = await fetch(`${API_HOST}/orders/${encodeURIComponent(orderId)}/payment`, { headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return showToast(d.message || 'Cannot pay this order');
    await payOnline(orderId, d); pollTracking(); loadCustomerOrders();
}

// ---------- forgot password ----------
function showReset() {
    ['#auth-signin-box', '#auth-signup-box', '#auth-profile-box'].forEach(x => $(x).style.display = 'none');
    $('#auth-reset-box').style.display = 'block'; $('#rs-step2').style.display = 'none'; $('#rs-msg').innerText = '';
    $('#rs-email').value = $('#cust-login-email').value;
}
$('#rs-send').onclick = async () => {
    try {
        const r = await fetch(`${API_HOST}/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#rs-email').value }) });
        const d = await r.json().catch(() => ({})); $('#rs-msg').innerText = d.message || 'Something went wrong';
        if (r.ok) $('#rs-step2').style.display = 'block';
    } catch (e) { $('#rs-msg').innerText = 'Cannot reach the server'; }
};
$('#rs-go').onclick = async () => {
    try {
        const r = await fetch(`${API_HOST}/auth/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#rs-email').value, code: $('#rs-code').value, password: $('#rs-pass').value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return $('#rs-msg').innerText = d.message || 'Could not reset';
        showToast('Password changed. Please sign in.'); $('#cust-login-email').value = $('#rs-email').value; toggleCustAuth('login');
    } catch (e) { $('#rs-msg').innerText = 'Cannot reach the server'; }
};

// ---------- saved delivery addresses ----------
async function loadAddresses() {
    try {
        const r = await fetch(`${API_HOST}/user/addresses`, { headers: authHeaders() });
        addresses = r.ok ? await r.json() : [];
    } catch (e) { addresses = []; }
    renderAddresses();
}
function showAddressForm(show) {
    $('#address-form').style.display = show ? 'block' : 'none';
    $('#add-address-btn').style.display = show ? 'none' : 'inline-block';
    if (show) { const u = getUser(); if (u && !$('#ad-phone').value) $('#ad-phone').value = u.phone || ''; $('#ad-error').innerText = ''; }
}
function renderAddresses() {
    const box = $('#address-list');
    if (!addresses.length) {
        box.innerHTML = '<p style="color:#64748b;font-size:1.2rem;">No saved address yet. Add one to continue.</p>';
        return showAddressForm(true);
    }
    box.innerHTML = addresses.map((a, i) => `
        <label class="address-card ${i === 0 ? 'active' : ''}">
            <input type="radio" name="delivery_address" value="${a.id}" ${i === 0 ? 'checked' : ''}>
            <div><strong>${esc(a.label)}</strong><p>${esc(a.line)}</p><p>Phone: ${esc(a.phone)}${a.lat != null ? ' · 📍 pinned' : ''}</p></div>
            <button type="button" data-act="deladdr" data-id="${a.id}" title="Remove address" style="margin-left:auto;border:0;background:none;color:#ef4444;cursor:pointer;font-size:1.8rem;">&times;</button>
        </label>`).join('');
    showAddressForm(false);
}
async function deleteAddress(id) {
    if (!confirm('Remove this address?')) return;
    await fetch(`${API_HOST}/user/addresses/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
    loadAddresses();
}
$('#ad-locate').onclick = () => {
    if (!navigator.geolocation) return ($('#ad-error').innerText = 'Your browser cannot share location');
    $('#ad-pin').innerText = 'Finding you…';
    navigator.geolocation.getCurrentPosition(pos => { addrPin = { lat: pos.coords.latitude, lng: pos.coords.longitude }; $('#ad-pin').innerText = '✓ Location pinned (the rider will see it on the map)'; },
        () => { addrPin = null; $('#ad-pin').innerText = ''; $('#ad-error').innerText = 'Could not get location. You can still save the address.'; }, { enableHighAccuracy: true, timeout: 10000 });
};
$('#add-address-btn').onclick = () => showAddressForm(true);
$('#cancel-address-btn').onclick = () => { if (addresses.length) showAddressForm(false); else $('#ad-error').innerText = 'Please add at least one address'; };
$('#save-address-btn').onclick = async () => {
    const err = $('#ad-error'); err.innerText = '';
    try {
        const r = await fetch(`${API_HOST}/user/addresses`, { method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ label: $('#ad-label').value, line: $('#ad-line').value, phone: $('#ad-phone').value, lat: addrPin && addrPin.lat, lng: addrPin && addrPin.lng }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { err.innerText = d.message || 'Could not save address'; if (r.status === 401) handleCustomerLogout(); return; }
        $('#ad-line').value = ''; addrPin = null; $('#ad-pin').innerText = ''; await loadAddresses();
    } catch (e) { err.innerText = 'Cannot reach the server'; }
};
document.addEventListener('change', e => {                // highlight the selected address / payment card
    if (!e.target.matches('input[name="delivery_address"], input[name="payment_mode"]')) return;
    document.querySelectorAll(`input[name="${e.target.name}"]`).forEach(i => i.closest('label').classList.toggle('active', i.checked));
});

// ---------- invoice, problems, rating ----------
function renderTrackActions(o) {
    const box = $('#track-actions'), tok = localStorage.getItem('groco_cust_token') || '';
    const delivered = o.status === 'Delivered', fresh = delivered && o.delivered_at && (Date.now() - new Date(o.delivered_at.replace(' ', 'T')).getTime()) < 48 * 3600e3;
    let h = `<a class="g-actbtn" target="_blank" href="${API_HOST}/orders/${encodeURIComponent(o.id)}/invoice?token=${encodeURIComponent(tok)}"><i class="fa fa-file-text-o"></i> Invoice</a>`;
    if (o.payment_status === 'pending' && o.status === 'Placed') h += `<button class="g-actbtn fill" data-act="paynow" data-id="${esc(o.id)}">Pay now</button>`;
    if (fresh) h += `<button class="g-actbtn" data-act="issue" data-id="${esc(o.id)}">Report a problem</button>`;
    if (delivered && o.rider_name) h += o.my_rating ? `<span style="font-size:1.3rem;">You rated the delivery ${'⭐'.repeat(o.my_rating)}</span>`
        : `<span class="stars" style="display:inline-flex;align-items:center;"><span style="font-size:1.25rem;margin-right:.4rem;">Rate your rider:</span>${[1, 2, 3, 4, 5].map(n => `<button data-act="rate" data-id="${esc(o.id)}" data-stars="${n}">★</button>`).join('')}</span>`;
    box.innerHTML = h;
    if (delivered) fetch(`${API_HOST}/orders/${encodeURIComponent(o.id)}/issues`, { headers: authHeaders() }).then(r => r.json()).then(list => {
        if (Array.isArray(list) && list.length) box.insertAdjacentHTML('afterend', `<div id="issue-list" style="font-size:1.2rem;color:#475569;">${list.map(i => `<div>Report: ${esc(i.title)}: <b>${esc(i.status === 'approved' ? 'Refund approved ₹' + i.refund_amount : i.status)}</b></div>`).join('')}</div>`);
    }).catch(() => {});
}
function reportIssue(orderId) {
    const o = lastOrders.find(x => x.id === orderId); if (!o) return;
    let items = []; try { items = JSON.parse(o.items); } catch (e) {}
    gsheet(`<h3>Report a problem</h3><label>Which item?</label><select id="is-item">${items.map(i => `<option value="${esc(i.barcode)}">${esc(i.title)} (${esc(i.variant)})</option>`).join('')}</select>
        <label>What went wrong?</label><select id="is-reason"><option value="missing">Item missing</option><option value="damaged">Damaged or leaking</option><option value="wrong">Wrong item</option><option value="quality">Poor quality / expired</option><option value="other">Other</option></select>
        <label>Tell us more (optional)</label><textarea id="is-note" rows="3"></textarea><p id="is-err" style="color:#ef4444;min-height:1.4rem;"></p>
        <div style="display:flex;gap:1rem;margin-top:1rem;"><button class="g-actbtn" onclick="closeSheet()">Cancel</button><button class="g-actbtn fill" id="is-go">Send report</button></div>`);
    $('#is-go').onclick = async () => {
        const r = await fetch(`${API_HOST}/orders/${encodeURIComponent(orderId)}/issue`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ barcode: $('#is-item').value, reason: $('#is-reason').value, note: $('#is-note').value, qty: 1 }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return $('#is-err').innerText = d.message || 'Could not send';
        closeSheet(); showToast('Report sent. We will review it soon.'); pollTracking();
    };
}
async function rateRider(orderId, stars) {
    const r = await fetch(`${API_HOST}/orders/${encodeURIComponent(orderId)}/rate`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ stars }) });
    const d = await r.json().catch(() => ({})); showToast(r.ok ? 'Thanks for rating!' : (d.message || 'Could not rate')); pollTracking();
}

// ---------- order tracking (live) ----------
function stepIndex(status) { return TRACK_STEPS.findIndex(x => x === status); }
function pinIcon(emoji) { return L.divIcon({ html: `<div style="font-size:2.6rem;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">${emoji}</div>`, className: '', iconSize: [30, 30], iconAnchor: [15, 28] }); }
function destroyMap() { if (trackMap) { trackMap.remove(); trackMap = null; riderMarker = null; } $('#track-map').style.display = 'none'; }
function updateRiderOnMap(lat, lng) {
    if (!trackMap || lat == null) return;
    if (!riderMarker) riderMarker = L.marker([lat, lng], { icon: pinIcon('🛵') }).addTo(trackMap); else riderMarker.setLatLng([lat, lng]);
    const pts = [[lat, lng]]; trackMap.eachLayer(l => { if (l.__dest) pts.push(l.getLatLng()); });
    pts.length > 1 ? trackMap.fitBounds(pts, { padding: [40, 40], maxZoom: 16 }) : trackMap.setView([lat, lng], 16);
}
async function showTrackExtras(o) {
    const box = $('#track-extra'), active = !['Delivered', 'Cancelled'].includes(o.status);
    let html = '';
    try {
        const r = await fetch(`${API_HOST}/orders/${encodeURIComponent(o.id)}/track`, { headers: authHeaders() });
        if (!r.ok) throw new Error();
        const t = await r.json();
        if (active && t.otp) html += `<div class="otp-box">Share this code with the rider when your order arrives<b>${esc(t.otp)}</b></div>`;
        if (t.rider) html += `<div class="rider-box"><span>🛵 <b>${esc(t.rider.name)}</b> is bringing your order</span><a href="tel:${esc(t.rider.phone || '')}"><i class="fa fa-phone"></i> Call</a></div>`;
        box.innerHTML = html;
        if (t.rider && typeof L !== 'undefined') {
            const mapEl = $('#track-map'); mapEl.style.display = 'block';
            if (!trackMap) {
                trackMap = L.map('track-map', { zoomControl: true }).setView(t.dest ? [t.dest.lat, t.dest.lng] : [19.2, 72.97], 14);
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(trackMap);
                if (t.dest) { const m = L.marker([t.dest.lat, t.dest.lng], { icon: pinIcon('🏠') }).addTo(trackMap); m.__dest = true; }
                setTimeout(() => trackMap && trackMap.invalidateSize(), 250);
            }
            if (t.rider.lat != null) updateRiderOnMap(t.rider.lat, t.rider.lng);
            else box.innerHTML += '<p style="font-size:1.2rem;color:#64748b;">Waiting for the rider’s live location…</p>';
        } else destroyMap();
    } catch (e) { box.innerHTML = ''; destroyMap(); }
}
function renderTracking(o) {
    const idx = stepIndex(o.status), cancelled = o.status === 'Cancelled';
    $('#tracking-title').innerText = cancelled ? 'Order cancelled' : idx === 4 ? 'Order delivered!' : 'Order ' + o.id;
    $('#tracking-sub').innerText = cancelled ? 'Items were returned to stock.' : idx === 4 ? 'Enjoy your groceries 🎉' : STEP_LABEL[o.status] || o.status;
    $('#tracking-steps').innerHTML = cancelled ? '' : TRACK_STEPS.map((t, i) => `
        <div style="display:flex;align-items:center;gap:1rem;padding:.5rem 0;opacity:${i <= idx ? 1 : .4}">
            <i class="fa ${i <= idx ? 'fa-check-circle' : 'fa-circle-o'}" style="color:#00b761;font-size:1.8rem"></i>
            <span style="font-size:1.4rem;font-weight:${i === idx ? 700 : 500}">${STEP_LABEL[t]}</span>
        </div>`).join('');
    let items = []; try { items = JSON.parse(o.items); } catch (e) {}
    $('#tracking-details').innerHTML = `
        <div style="border-top:1px solid #e2e8f0;padding-top:1rem;">
            ${items.map(i => `<div style="display:flex;justify-content:space-between;gap:1rem;"><span>${esc(i.title)} (${esc(i.variant)}) × ${i.qty}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
            ${o.discount ? `<div style="display:flex;justify-content:space-between;color:#00b761;"><span>Coupon</span><span>-${money(o.discount)}</span></div>` : ''}
            <div style="display:flex;justify-content:space-between;font-weight:700;margin-top:.4rem;"><span>Total (${esc(o.payment_mode)})</span><span>${money(o.total_amount)}</span></div>
            <p style="margin-top:.8rem;"><b>Deliver to:</b> ${esc(o.address)}</p>
            <p style="color:#64748b;">Placed: ${esc(o.created_at)}${o.delivered_at ? ' · Delivered: ' + esc(o.delivered_at) : ''}</p>
            ${o.slot_label ? `<p style="color:#64748b;">Delivery: ${esc(o.slot_label)}</p>` : ''}
        </div>`;
    let adj = []; try { adj = JSON.parse(o.adjustments || '[]'); } catch (e) {}
    if (adj.length) $('#tracking-details').innerHTML += adj.map(a => `<div class="adj">Not available: ${esc(a.title)} (${esc(a.variant)}) × ${a.qty}. Removed from your bill${o.payment_status === 'paid' || o.payment_status === 'refunded' ? ' and refunded' : ''}.</div>`).join('');
    renderTrackActions(o);
    showTrackExtras(o);
}
async function pollTracking() {
    if (!trackingOrderId) return;
    try {
        const r = await fetch(`${API_HOST}/user/my-orders`, { headers: authHeaders() });
        if (!r.ok) return;
        const orders = await r.json();
        loadCustomerOrders(orders);
        const o = orders.find(x => x.id === trackingOrderId);
        if (o) renderTracking(o);
    } catch (e) {}
}
async function openTracking(orderId) {
    closeAll();
    trackingOrderId = orderId;
    trackingModal.classList.add('active'); overlayBackdrop.classList.add('active');
    await pollTracking();
    clearInterval(trackTimer); trackTimer = setInterval(pollTracking, 30000);   // backup; live events arrive instantly
}
function closeTracking(silent) {
    clearInterval(trackTimer); trackingOrderId = null; destroyMap();
    trackingModal.classList.remove('active');
    if (!silent) overlayBackdrop.classList.remove('active');
}
$('#close-tracking-btn').onclick = () => closeTracking();
$('#tracking-done-btn').onclick = () => closeTracking();

// ---------- live updates from the server (Server-Sent Events) ----------
function connectLive() {
    if (es) { es.close(); es = null; }
    if (typeof EventSource === 'undefined') return;
    const t = localStorage.getItem('groco_cust_token') || '';
    es = new EventSource(`${API_HOST}/events?token=${encodeURIComponent(t)}`);
    es.addEventListener('catalog', () => { catalogSig = ''; loadCatalog(); });
    es.addEventListener('order:update', ev => {
        const d = JSON.parse(ev.data);
        showToast(`Order ${d.id}: ${STEP_LABEL[d.status] || d.status}`);
        loadCustomerOrders();
        if (trackingOrderId === d.id) pollTracking();
    });
    es.addEventListener('rider:location', ev => { const d = JSON.parse(ev.data); if (trackingOrderId === d.order_id) updateRiderOnMap(d.lat, d.lng); });
}

async function cancelMyOrder(id) {
    if (!confirm('Cancel order ' + id + '?')) return;
    const r = await fetch(`${API_HOST}/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    showToast(r.ok ? 'Order cancelled' : (d.message || 'Could not cancel'));
    catalogSig = ''; loadCatalog(); loadCustomerOrders();
}

// ---------- customer auth + My Orders ----------
function toggleCustAuth(mode) {
    $('#auth-reset-box').style.display = 'none';
    $('#auth-signin-box').style.display = mode === 'login' ? 'block' : 'none';
    $('#auth-signup-box').style.display = mode === 'register' ? 'block' : 'none';
    $('#auth-profile-box').style.display = 'none';
}
async function authCall(path, body, okMsg, errSel) {
    const err = $(errSel); err.innerText = '';
    try {
        const res = await fetch(`${API_HOST}/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.token) {
            localStorage.setItem('groco_cust_token', d.token);
            localStorage.setItem('groco_cust_user', JSON.stringify(d.user));
            showToast(okMsg); checkCustomerAuth(); connectLive();
        } else err.innerText = d.message || 'Something went wrong. Please try again.';
    } catch (e) { err.innerText = 'Cannot reach the server. Is node server.js running?'; }
}
function handleCustomerLogin() {
    const email = $('#cust-login-email').value.trim().toLowerCase(), password = $('#cust-login-password').value;
    if (!email || !password) return $('#auth-error-login').innerText = 'Enter your email and password';
    authCall('login', { email, password }, 'Welcome back!', '#auth-error-login');
}
function handleCustomerRegister() {
    const name = $('#cust-reg-name').value.trim(), email = $('#cust-reg-email').value.trim().toLowerCase();
    const phone = $('#cust-reg-phone').value.trim(), password = $('#cust-reg-password').value, err = $('#auth-error-reg');
    if (name.length < 2) return err.innerText = 'Enter your full name';
    if (!/^\S+@\S+\.\S+$/.test(email)) return err.innerText = 'Enter a valid email address';
    if (phone && phone.replace(/\D/g, '').length < 10) return err.innerText = 'Enter a valid 10-digit mobile number';
    if (password.length < 6) return err.innerText = 'Password must be at least 6 characters';
    authCall('register', { name, email, phone, password }, 'Account created. Welcome to Groco!', '#auth-error-reg');
}
async function verifySession() {                          // drop stale/expired tokens quietly
    if (!localStorage.getItem('groco_cust_token')) return;
    try {
        const r = await fetch(`${API_HOST}/auth/me`, { headers: authHeaders() });
        if (r.status === 401 || r.status === 403) return handleCustomerLogout(true);
        if (r.ok) { localStorage.setItem('groco_cust_user', JSON.stringify(await r.json())); checkCustomerAuth(); }
    } catch (e) {}
}
function checkCustomerAuth() {
    const user = getUser(), token = localStorage.getItem('groco_cust_token');
    if (token && user && user.email) {
        $('#auth-signin-box').style.display = 'none'; $('#auth-signup-box').style.display = 'none'; $('#auth-profile-box').style.display = 'block';
        $('#cust-name-display').innerText = user.name || 'Customer';
        $('#cust-email-display').innerText = user.email;
        $('#cust-phone-display').innerText = user.phone ? 'Phone: ' + user.phone : '';
        $('#cust-avatar').innerText = (user.name || user.email)[0].toUpperCase();
        loadCustomerOrders();
    } else toggleCustAuth('login');
}
let lastOrders = [], shop = null;
async function loadCustomerOrders(preloaded) {
    const box = $('#customer-orders-list'); if (!box) return;
    try {
        let orders = preloaded;
        if (!Array.isArray(orders)) {
            const res = await fetch(`${API_HOST}/user/my-orders`, { headers: authHeaders() });
            if (res.status === 401 || res.status === 403) return handleCustomerLogout(true);
            orders = await res.json();
        }
        lastOrders = orders; renderOrderList();
    } catch (e) { box.innerHTML = '<p style="font-size:0.85rem;color:#ef4444;">Could not load orders.</p>'; }
}
function orderRow(o) {
    let items = []; try { items = JSON.parse(o.items); } catch (e) {}
    const col = o.status === 'Delivered' ? '#00b761' : o.status === 'Cancelled' ? '#ef4444' : '#0284c7';
    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:0.6rem;margin-bottom:0.5rem;font-size:0.85rem;">
        <div style="display:flex;justify-content:space-between;font-weight:700;"><span>${esc(o.id)}</span><span style="color:#00b761;">${money(o.total_amount)}</span></div>
        <div style="color:#64748b;font-size:0.78rem;">${esc(o.created_at)}</div>
        <div style="color:#475569;font-size:0.8rem;margin:0.2rem 0;">${items.map(i => esc(i.title) + ' ×' + i.qty).join(', ')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.4rem;">
            <span style="color:${col};font-weight:700;">${o.payment_status === 'pending' && o.status === 'Placed' ? 'Awaiting payment' : esc(STEP_LABEL[o.status] || o.status)}</span>
            <span>
              ${o.payment_status === 'pending' && o.status === 'Placed' ? `<button type="button" data-act="paynow" data-id="${esc(o.id)}" style="border:0;background:#f59e0b;color:#fff;border-radius:4px;padding:.25rem .7rem;cursor:pointer;">Pay now</button>` : ''}
              ${o.status === 'Placed' ? `<button type="button" data-act="cancel" data-id="${esc(o.id)}" style="border:1px solid #ef4444;background:#fff;color:#ef4444;border-radius:4px;padding:.2rem .6rem;cursor:pointer;">Cancel</button>` : ''}
              <button type="button" data-act="track" data-id="${esc(o.id)}" style="border:0;background:#00b761;color:#fff;border-radius:4px;padding:.25rem .7rem;cursor:pointer;">${['Delivered', 'Cancelled'].includes(o.status) ? 'Details' : 'Track'}</button>
            </span>
        </div></div>`;
}
function renderOrderList() {
    const box = $('#customer-orders-list');
    if (!lastOrders.length) { box.innerHTML = '<p style="font-size:0.85rem;color:#94a3b8;">No orders placed yet.</p>'; return; }
    const active = lastOrders.filter(o => !['Delivered', 'Cancelled'].includes(o.status));
    const past = lastOrders.filter(o => ['Delivered', 'Cancelled'].includes(o.status));
    box.innerHTML = (active.length ? `<div class="order-sec">Active orders</div>${active.map(orderRow).join('')}` : '')
        + (past.length ? `<div class="order-sec">Order history</div>${past.slice(0, ordersShown).map(orderRow).join('')}
            ${past.length > ordersShown ? '<button type="button" onclick="ordersShown+=10;renderOrderList()" style="width:100%;border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:.4rem;cursor:pointer;">Show older orders</button>' : ''}` : '');
}
function handleCustomerLogout(silent) {
    localStorage.removeItem('groco_cust_token'); localStorage.removeItem('groco_cust_user');
    addresses = []; checkCustomerAuth(); connectLive(); if (silent !== true) showToast('Logged out');
}
['#cust-reg-name', '#cust-reg-email', '#cust-reg-phone', '#cust-reg-password'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') handleCustomerRegister(); }));
['#cust-login-email', '#cust-login-password'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') handleCustomerLogin(); }));

// ---------- drawers ----------
$('#cart-btn').onclick = () => { const open = shoppingCart.classList.contains('active'); closeAll(); if (!open) shoppingCart.classList.add('active'); };
$('#close-cart-btn').onclick = () => shoppingCart.classList.remove('active');
$('#login-btn').onclick = () => { const open = loginForm.classList.contains('active'); closeAll(); if (!open) { loginForm.classList.add('active'); if (getUser()) loadCustomerOrders(); } };
overlayBackdrop.onclick = closeAll;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });

function copyCoupon() {
    $('#promo-input').value = 'GROCO50';
    showToast('Code GROCO50 added. Open your cart and tap Apply');
}
$('#hero-search').onclick = openSearch;

// ---------- boot ----------
updateCartUI();
checkCustomerAuth();
loadCatalog();
loadShopSettings();
verifySession();
connectLive();                            // instant updates: new products, stock, order status
setInterval(loadCatalog, 30000);          // safety net if the live connection drops
