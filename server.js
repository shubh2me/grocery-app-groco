require('./lib/env')();                                   // loads .env (Razorpay keys, SMS keys, etc.)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { tileSvg, CAT_EMOJI } = require('./lib/tile');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'groco_super_secret_jwt_key_2026';
if (!process.env.JWT_SECRET) console.warn('⚠  Using default JWT secret. Set JWT_SECRET before going live.');

if (process.env.TRUST_PROXY) app.set('trust proxy', 1);                   // set when running behind a host / proxy so rate limits see real IPs
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' }); if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000'); next(); });
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- static files: only public folders + the two pages ----------
['css', 'js', 'image'].forEach(d => app.use('/' + d, express.static(path.join(__dirname, d))));
['/', '/index.html'].forEach(r => app.get(r, (q, s) => s.sendFile(path.join(__dirname, 'index.html'))));
app.get('/admin.html', (q, s) => s.sendFile(path.join(__dirname, 'admin.html')));
app.get('/staff.html', (q, s) => s.sendFile(path.join(__dirname, 'staff.html')));

const uploadDir = path.join(__dirname, 'image', 'uploads');
const prodImgDir = path.join(__dirname, 'image', 'products');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(prodImgDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: (q, f, cb) => cb(null, uploadDir),
        filename: (q, f, cb) => cb(null, Date.now() + '-' + f.originalname.replace(/[^\w.\-]/g, '_'))
    }),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (q, f, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(f.mimetype))
});

// ---------- database helpers ----------
const db = new sqlite3.Database(path.join(__dirname, 'groco.db'));
db.run('PRAGMA journal_mode = WAL');
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ message: 'Server error' }); });
const stock = require('./lib/stock')(run, get, all);
const notify = require('./lib/notify')(run, get, all);
const payments = require('./lib/payments');
const push = require('./lib/push')(run, get, all);
const backup = require('./lib/backup')(run, __dirname);
const { invoiceHtml } = require('./lib/gst');

// ---------- settings (delivery rules, store details, GST) ----------
let sCache = { at: 0, v: {} };
async function settings() {
    if (Date.now() - sCache.at > 3000) { const o = {}; for (const r of await all('SELECT key,value FROM settings')) o[r.key] = r.value; sCache = { at: Date.now(), v: o }; }
    return sCache.v;
}
const bustSettings = () => { sCache.at = 0; };
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = m => { const h = Math.floor(m / 60), ap = h >= 12 ? 'PM' : 'AM'; return `${((h + 11) % 12) + 1}${m % 60 ? ':' + pad2(m % 60) : ''} ${ap}`; };
function makeSlots(st, now = new Date()) {                      // hourly delivery windows today (and tomorrow if it is late)
    const [oh, om] = String(st.store_open || '08:00').split(':').map(Number), [ch, cm] = String(st.store_close || '22:00').split(':').map(Number);
    const openMin = oh * 60 + om, closeMin = ch * 60 + cm, nowMin = now.getHours() * 60 + now.getMinutes();
    const slots = [];
    for (let off = 0; off <= 1 && slots.length < 10; off++) {
        const d = new Date(now); d.setDate(d.getDate() + off);
        const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        for (let m = Math.ceil(openMin / 60) * 60; m + 60 <= closeMin; m += 60) {
            if (off === 0 && m < nowMin + 45) continue;
            slots.push({ value: `${ymd} ${pad2(m / 60)}:00`, label: `${off ? 'Tomorrow' : 'Today'} ${fmtTime(m)} – ${fmtTime(m + 60)}` });
        }
    }
    return { isOpen: nowMin >= openMin && nowMin < closeMin - 15, slots: slots.slice(0, 10) };
}
async function userByEmail(email) { return get('SELECT id,name,email,phone FROM users WHERE email=?', [email]); }
const MSGS = {
    Placed: o => `Groco: order ${o.id} confirmed. Total ₹${o.total_amount}. Your delivery code is ${o.otp}. Share it only with the rider at your door.`,
    Dispatched: (o, x) => `Groco: ${x.rider || 'your rider'} is on the way with order ${o.id}. Delivery code ${o.otp}.${o.payment_mode === 'COD' ? ` Please keep ₹${o.total_amount} ready.` : ''}`,
    Delivered: o => `Groco: order ${o.id} delivered. Thank you for shopping with us!`,
    Cancelled: o => `Groco: order ${o.id} was cancelled.${o.payment_status === 'paid' || o.payment_status === 'refunded' ? ' Your refund has been initiated.' : ''}`
};
async function notifyOrder(orderId, status, extra = {}) {              // SMS / WhatsApp / email to the customer (best effort)
    try {
        const o = await get('SELECT * FROM orders WHERE id=?', [orderId]); if (!o || !MSGS[status]) return;
        const u = await userByEmail(o.customer_email);
        await notify.send({ phone: o.customer_phone || (u && u.phone), email: o.customer_email }, MSGS[status](o, extra), `Order ${o.id}`);
    } catch (e) { console.error('notify failed', e.message); }
}
async function createRefund(orderId, amount, reason, auto = true) {   // paid orders: record the refund; try the gateway automatically
    amount = Math.round(amount * 100) / 100; if (!(amount > 0)) return null;
    const o = await get('SELECT * FROM orders WHERE id=?', [orderId]);
    const r = await run('INSERT INTO refunds (order_id,amount,reason,status,method) VALUES (?,?,?,?,?)', [orderId, amount, reason, 'pending', o && o.payment_mode === 'COD' ? 'manual' : 'original']);
    if (auto && o && o.rzp_payment_id && !String(o.rzp_payment_id).startsWith('demo') && payments.enabled()) {
        try { await payments.refund(o.rzp_payment_id, amount); await run(`UPDATE refunds SET status='processed', processed_at=datetime('now','localtime'), processed_by='razorpay' WHERE id=?`, [r.lastID]); }
        catch (e) { await run('UPDATE refunds SET note=? WHERE id=?', ['gateway refund failed: ' + e.message, r.lastID]); }
    }
    await run('UPDATE orders SET refunded = COALESCE(refunded,0) + ? WHERE id=?', [amount, orderId]);
    broadcast('refund:new', { order_id: orderId, amount }, toAdmins);
    return r.lastID;
}
async function announceNewOrder(o) {
    broadcast('order:new', { id: o.id, customer: o.customer_name, total: o.total_amount, items: JSON.parse(o.items || '[]').length }, u => u && ['admin', 'picker'].includes(u.role));
    push.toRole('picker', { title: '🧺 New order to pick', body: `${o.id} · ${JSON.parse(o.items || '[]').length} item(s)`, url: '/staff.html' }).catch(() => {});
    notifyOrder(o.id, 'Placed');
}
const STATUSES = ['Placed', 'Picking', 'Packed', 'Dispatched', 'Delivered', 'Cancelled'];

// ---------- REAL-TIME: Server-Sent Events ----------
const clients = new Set();
function broadcast(type, data, filter) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
        if (filter && !filter(c.user)) continue;
        try { c.res.write(msg); } catch (e) { clients.delete(c); }
    }
}
let catalogTimer = null;
function catalogChanged(reason) {                         // debounce bursts (e.g. one order touching 8 items)
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(() => broadcast('catalog', { reason, at: Date.now() }), 250);
}
const toAdmins = u => u && u.role === 'admin';
const toOwnerAndAdmins = email => u => u && (u.role === 'admin' || u.email === email);

app.get('/api/events', (req, res) => {
    let user = null;
    try { user = jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const c = { res, user };
    clients.add(c);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    res.on('close', () => { clearInterval(hb); clients.delete(c); });      // res (not req): on modern Node, req 'close' fires as soon as the request is read
});

// ---------- auth ----------
function auth(role) {
    return (req, res, next) => {
        const h = req.headers['authorization'] || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return res.status(401).json({ message: 'Please sign in' });
        try {
            const d = jwt.verify(token, JWT_SECRET);
            if (role) {
                const list = [].concat(role);
                if (!list.includes(d.role) && !(Array.isArray(role) && d.role === 'admin')) return res.status(403).json({ message: 'You do not have access to this' });
            }
            req.user = d; next();
        } catch (e) { res.status(401).json({ message: 'Session expired, please sign in again' }); }
    };
}
const needUser = auth(), needAdmin = auth('admin');
const needStaff = auth(['picker', 'rider']), needPicker = auth(['picker']), needRider = auth(['rider']);
const sign = u => jwt.sign({ id: u.id, role: u.role, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '7d' });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', role: u.role });

const attempts = new Map();                               // simple brute-force guard: 8 tries / 10 min per email+ip
function tooMany(key) {
    const now = Date.now(), a = (attempts.get(key) || []).filter(t => now - t < 600000);
    attempts.set(key, a);
    return a.length >= 8;
}
const failed = key => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

app.post('/api/auth/register', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
    const password = String(req.body.password || '');
    if (name.length < 2) return res.status(400).json({ message: 'Please enter your full name' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address' });
    if (phone && phone.replace(/\D/g, '').length < 10) return res.status(400).json({ message: 'Enter a valid 10-digit phone number' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (await get('SELECT id FROM users WHERE email=?', [email])) return res.status(400).json({ message: 'This email is already registered. Please sign in.' });
    const r = await run(`INSERT INTO users (name,email,password,phone,role) VALUES (?,?,?,?, 'customer')`, [name, email, await bcrypt.hash(password, 10), phone]);
    const user = { id: r.lastID, name, email, phone, role: 'customer' };
    res.status(201).json({ token: sign(user), user });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = email + '|' + req.ip;
    if (tooMany(key)) return res.status(429).json({ message: 'Too many attempts. Try again in a few minutes.' });
    const user = await get('SELECT * FROM users WHERE email=?', [email]);
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password))) {
        failed(key); return res.status(400).json({ message: 'Wrong email or password' });
    }
    if (user.active === 0) return res.status(403).json({ message: 'This account has been deactivated. Contact the admin.' });
    attempts.delete(key);
    res.json({ token: sign(user), user: publicUser(user) });
}));

app.get('/api/auth/me', needUser, wrap(async (req, res) => {
    const u = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!u) return res.status(401).json({ message: 'Account no longer exists' });
    res.json(publicUser(u));
}));

app.patch('/api/auth/me', needUser, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim(), phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
    if (name.length < 2) return res.status(400).json({ message: 'Enter your name' });
    await run('UPDATE users SET name=?, phone=? WHERE id=?', [name, phone, req.user.id]);
    const u = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
    res.json({ token: sign(u), user: publicUser(u) });
}));

app.post('/api/auth/password', needUser, wrap(async (req, res) => {
    const u = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!(await bcrypt.compare(String(req.body.current || ''), u.password))) return res.status(400).json({ message: 'Current password is wrong' });
    if (String(req.body.next || '').length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });
    await run('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(req.body.next, 10), req.user.id]);
    res.json({ success: true });
}));

// ---------- saved addresses ----------
app.get('/api/user/addresses', needUser, wrap(async (req, res) => {
    res.json(await all('SELECT * FROM addresses WHERE user_id=? ORDER BY id DESC', [req.user.id]));
}));
app.post('/api/user/addresses', needUser, wrap(async (req, res) => {
    const label = String(req.body.label || 'Home').trim().slice(0, 20), line = String(req.body.line || '').trim().slice(0, 250);
    const phone = String(req.body.phone || '').replace(/[^\d+]/g, '');
    if (line.length < 8) return res.status(400).json({ message: 'Enter the full address (flat, building, area, city)' });
    if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ message: 'Enter a 10-digit contact number' });
    const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
    const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const r = await run('INSERT INTO addresses (user_id,label,line,phone,lat,lng) VALUES (?,?,?,?,?,?)', [req.user.id, label, line, phone, ok ? lat : null, ok ? lng : null]);
    res.status(201).json(await get('SELECT * FROM addresses WHERE id=?', [r.lastID]));
}));
app.delete('/api/user/addresses/:id', needUser, wrap(async (req, res) => {
    await run('DELETE FROM addresses WHERE id=? AND user_id=?', [req.params.id, req.user.id]); res.json({ success: true });
}));

// ---------- catalog (public) ----------
let localCache = { at: 0, map: {} };
function localImages() {                                  // drop photos into image/products/<product_id>.jpg to use them automatically
    if (Date.now() - localCache.at > 5000) {
        const map = {};
        try { for (const f of fs.readdirSync(prodImgDir)) { const m = f.match(/^(.+)\.(jpe?g|png|webp|gif)$/i); if (m) map[m[1].toLowerCase()] = '/image/products/' + f; } } catch (e) {}
        localCache = { at: Date.now(), map };
    }
    return localCache.map;
}
function shape(p) {
    const loc = localImages();
    let image = p.image || '';
    if (!image.startsWith('/image/uploads/')) image = loc[String(p.barcode).toLowerCase()] || loc[String(p.product_id || '').toLowerCase()] || image;
    return { ...p, image: image || `/api/tile/${p.barcode}.svg`, stock: p.quantity, inStock: p.quantity > 0 ? 1 : 0 };
}
app.get('/api/products', wrap(async (req, res) => {
    res.json((await all('SELECT * FROM products ORDER BY created_at ASC, rowid ASC')).map(shape));
}));
app.get('/api/categories', wrap(async (req, res) => {
    const rows = await all('SELECT * FROM categories ORDER BY sort_order, name');
    res.json(rows.map(c => ({ ...c, emoji: CAT_EMOJI[c.id] || '🛒', subcategories: JSON.parse(c.subcategories || '[]') })));
}));
app.get('/api/tile/:barcode.svg', wrap(async (req, res) => {
    const p = await get('SELECT * FROM products WHERE barcode=?', [req.params.barcode]) || { title: 'Groco', category: '' };
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }).send(tileSvg(p));
}));

// ---------- coupon ----------
function couponDiscount(code, subtotal) {
    return (String(code || '').trim().toUpperCase() === 'GROCO50' && subtotal >= 299) ? 50 : 0;
}
app.post('/api/coupon/check', (req, res) => {
    const d = couponDiscount(req.body.code, Number(req.body.subtotal) || 0);
    d ? res.json({ discount: d }) : res.status(400).json({ message: 'GROCO50 works on orders of ₹299 or more' });
});

// ---------- orders (customer) ----------
app.post('/api/orders/place', needUser, wrap(async (req, res) => {
    const { address_id, items, coupon } = req.body, st = await settings();
    const online = ['ONLINE', 'UPI', 'Online'].includes(req.body.payment_mode);
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'Your cart is empty' });
    const addr = await get('SELECT * FROM addresses WHERE id=? AND user_id=?', [address_id, req.user.id]);
    if (!addr) return res.status(400).json({ message: 'Please choose or add a delivery address' });
    // delivery area
    const allowed = String(st.serviceable_pincodes || '').split(/[,\s]+/).filter(Boolean), pin = (addr.line.match(/\b\d{6}\b/) || [])[0];
    if (allowed.length && (!pin || !allowed.includes(pin))) return res.status(400).json({ message: pin ? `Sorry, we do not deliver to ${pin} yet.` : 'Please include your 6-digit pincode in the address.' });
    // delivery slot
    const sl = makeSlots(st); let slot = String(req.body.slot || 'ASAP'), slotLabel = 'ASAP (10-20 min)', slotAt = null;
    if (slot === 'ASAP') { if (!sl.isOpen) return res.status(400).json({ message: `The store is closed right now (open ${st.store_open} to ${st.store_close}). Please pick a delivery slot.` }); }
    else { const f = sl.slots.find(x => x.value === slot); if (!f || st.slots_enabled === '0') return res.status(400).json({ message: 'That delivery slot is not available. Please choose another.' }); slotLabel = f.label; slotAt = f.value; }

    const rates = JSON.parse(st.gst_rates || '{}'), lines = [];
    for (const it of items) {                              // prices & names always come from the DB, never the browser
        const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
        const p = await get('SELECT * FROM products WHERE barcode=?', [it.barcode]);
        if (!p) return res.status(400).json({ message: `"${it.title || it.barcode}" is no longer available` });
        const ex = lines.find(l => l.barcode === p.barcode);
        if (ex) ex.qty += qty; else lines.push({ barcode: p.barcode, title: p.title, variant: p.variant, qty, price: p.price, category: p.category, gst: rates[p.category] ?? 0 });
    }
    const subtotal = lines.reduce((t, l) => t + l.price * l.qty, 0);
    if (subtotal < Number(st.min_order || 0)) return res.status(400).json({ message: `Minimum order is ₹${st.min_order}. Add ₹${Math.ceil(st.min_order - subtotal)} more.` });
    const discount = couponDiscount(coupon, subtotal), fee = subtotal >= Number(st.free_delivery_above || 0) ? 0 : Number(st.delivery_fee || 0), total = subtotal - discount + fee;

    const taken = [];
    for (const l of lines) {                               // atomic per-item stock deduction
        const r = await run('UPDATE products SET quantity = quantity - ? WHERE barcode=? AND quantity >= ?', [l.qty, l.barcode, l.qty]);
        if (r.changes === 0) {
            for (const t of taken) await stock.restore(t.barcode, t.qty);
            const cur = await get('SELECT quantity FROM products WHERE barcode=?', [l.barcode]);
            catalogChanged('stock');
            return res.status(409).json({ message: `Only ${cur ? cur.quantity : 0} left of "${l.title} (${l.variant})"` });
        }
        await stock.deduct(l.barcode, l.qty);                // takes from the soonest-expiring batch first
        taken.push(l);
    }
    const addrText = `${addr.label}: ${addr.line}`;
    let id;
    for (let i = 0; i < 5; i++) {
        id = 'ORD-' + Date.now().toString().slice(-6) + Math.floor(10 + Math.random() * 90);
        try {
            await run(`INSERT INTO orders (id,customer_email,customer_name,customer_phone,address,dest_lat,dest_lng,items,subtotal,total_amount,discount,delivery_fee,coupon,payment_mode,payment_status,slot_label,slot_at,status,otp)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Placed', ?)`,
                [id, req.user.email, req.user.name, addr.phone, addrText, addr.lat, addr.lng, JSON.stringify(lines), subtotal, total, discount, fee, discount ? String(coupon).toUpperCase() : null,
                 online ? 'Online' : 'COD', online ? 'pending' : 'cod', slotLabel, slotAt, String(Math.floor(1000 + Math.random() * 9000))]);
            break;
        } catch (e) { if (i === 4) throw e; }
    }
    catalogChanged('stock');
    let pay = null;
    if (online) {
        if (payments.enabled()) {
            try { const ro = await payments.createOrder(total, id); await run('UPDATE orders SET rzp_order_id=? WHERE id=?', [ro.id, id]); pay = { provider: 'razorpay', key: payments.keyId(), order_id: ro.id, amount: Math.round(total * 100), name: req.user.name, email: req.user.email, phone: addr.phone }; }
            catch (e) { await cancelOrder(id, null, 'payment gateway error'); return res.status(502).json({ message: 'Payment service is unavailable right now: ' + e.message }); }
        } else pay = { provider: 'demo', amount: Math.round(total * 100) };
    } else announceNewOrder(await get('SELECT * FROM orders WHERE id=?', [id]));
    res.status(201).json({ success: true, orderId: id, total, fee, payment: pay });
}));

app.get('/api/user/my-orders', needUser, wrap(async (req, res) => {
    res.json(await all(`SELECT o.*, ru.name rider_name, ru.phone rider_phone, (SELECT stars FROM ratings r WHERE r.order_id=o.id) my_rating FROM orders o LEFT JOIN users ru ON ru.id=o.rider_id
                        WHERE o.customer_email=? ORDER BY o.created_at DESC, o.rowid DESC`, [req.user.email]));
}));

async function cancelOrder(id, email, why) {
    const o = await get('SELECT * FROM orders WHERE id=?', [id]);
    if (!o || (email && o.customer_email !== email)) return { code: 404, message: 'Order not found' };
    if (o.status === 'Cancelled') return { code: 400, message: 'Already cancelled' };
    if (email && o.status !== 'Placed') return { code: 400, message: 'This order is already being prepared and can no longer be cancelled' };
    if (o.status === 'Delivered') return { code: 400, message: 'Delivered orders cannot be cancelled. Report a problem instead.' };
    if (o.status === 'Dispatched') return { code: 400, message: 'Order is already out for delivery' };
    for (const l of JSON.parse(o.items || '[]')) await stock.restore(l.barcode, l.qty);
    await run(`UPDATE orders SET status='Cancelled', updated_at=datetime('now','localtime') WHERE id=?`, [id]);
    if (o.payment_status === 'paid') {                       // money was taken: refund it
        const left = o.total_amount - (o.refunded || 0);
        await createRefund(id, left, why || 'order cancelled');
        await run(`UPDATE orders SET payment_status='refunded' WHERE id=?`, [id]);
    }
    catalogChanged('stock');
    broadcast('order:update', { id, status: 'Cancelled' }, toOwnerAndAdmins(o.customer_email));
    notifyOrder(id, 'Cancelled');
    return { code: 200 };
}
app.post('/api/orders/:id/cancel', needUser, wrap(async (req, res) => {
    const r = await cancelOrder(req.params.id, req.user.email);
    res.status(r.code).json(r.code === 200 ? { success: true } : { message: r.message });
}));

// ---------- admin ----------
app.get('/api/admin/stats', needAdmin, wrap(async (req, res) => {
    const o = await get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status!='Cancelled' THEN total_amount END),0) rev,
        SUM(CASE WHEN status='Placed' THEN 1 ELSE 0 END) pending,
        COALESCE(SUM(CASE WHEN status!='Cancelled' AND date(created_at)=date('now','localtime') THEN total_amount END),0) today,
        SUM(CASE WHEN date(created_at)=date('now','localtime') THEN 1 ELSE 0 END) today_orders FROM orders`);
    const s = await get(`SELECT COUNT(*) total, SUM(CASE WHEN quantity<=0 THEN 1 ELSE 0 END) out,
        SUM(CASE WHEN quantity>0 AND quantity<=10 THEN 1 ELSE 0 END) low FROM products`);
    const c = await get(`SELECT COUNT(*) n FROM users WHERE role='customer'`);
    res.json({ orders: o.n, todayOrders: o.today_orders || 0, revenue: o.rev, today: o.today, pending: o.pending || 0, products: s.total, outOfStock: s.out || 0, lowStock: s.low || 0, customers: c.n });
}));

app.post('/api/admin/upload', needAdmin, upload.single('imageFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Choose a PNG, JPG, WEBP or GIF image (max 3 MB)' });
    res.json({ url: '/image/uploads/' + req.file.filename });
});

async function createProduct(b, file, userName) {
    const title = String(b.title || '').trim(), variant = String(b.variant || '').trim();
    const price = parseFloat(b.price), qty = Math.max(0, parseInt(b.quantity, 10) || 0);
    if (!title || !variant || !b.category || !(price > 0)) return { code: 400, message: 'Name, size, category and price are required' };
    if (b.expiry_date && !stock.validDate(b.expiry_date)) return { code: 400, message: 'Expiry date must look like 2026-12-31' };
    let image = String(b.image || '').trim();
    if (file) image = '/image/uploads/' + file.filename;
    let barcode = String(b.barcode || '').trim();
    if (!barcode) do { barcode = '890' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0') + '0'; } while (await get('SELECT 1 FROM products WHERE barcode=?', [barcode]));
    else if (await get('SELECT 1 FROM products WHERE barcode=?', [barcode])) return { code: 400, message: 'That barcode already exists' };
    await run(`INSERT INTO products (barcode,product_id,title,category,subcategory,brand,variant,price,oldPrice,image,description,quantity,inStock,isBestSeller)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?)`,
        [barcode, String(b.product_id || '').trim() || barcode, title, b.category, b.subcategory || 'General', b.brand || 'Groco', variant, price,
         parseFloat(b.oldPrice) || price, image, b.description || '', b.isBestSeller ? 1 : 0]);
    await stock.log('new_product', barcode, 0, 'product created', null, userName);
    if (qty > 0) await stock.addBatch(barcode, qty, b.expiry_date, b.batch_no, userName);
    catalogChanged('product-added');
    return { code: 201, product: shape(await get('SELECT * FROM products WHERE barcode=?', [barcode])) };
}
app.post('/api/admin/products', needAdmin, upload.single('imageFile'), wrap(async (req, res) => {
    const r = await createProduct(req.body, req.file, req.user.name);
    res.status(r.code).json(r.product || { message: r.message });
}));

app.put('/api/admin/products/:barcode', needAdmin, wrap(async (req, res) => {
    const cur = await get('SELECT * FROM products WHERE barcode=?', [req.params.barcode]);
    if (!cur) return res.status(404).json({ message: 'Product not found' });
    const b = { ...cur, ...req.body };
    if (!(parseFloat(b.price) > 0)) return res.status(400).json({ message: 'Price must be more than 0' });
    await run(`UPDATE products SET title=?,category=?,subcategory=?,brand=?,variant=?,price=?,oldPrice=?,image=?,description=?,isBestSeller=? WHERE barcode=?`,
        [b.title, b.category, b.subcategory, b.brand, b.variant, parseFloat(b.price), parseFloat(b.oldPrice) || parseFloat(b.price),
         (b.image || '').startsWith('/api/tile/') ? '' : b.image, b.description, b.isBestSeller ? 1 : 0, req.params.barcode]);
    if (req.body.quantity !== undefined) await stock.setStock(req.params.barcode, Math.max(0, parseInt(req.body.quantity, 10) || 0), req.user.name, 'edited in admin');
    catalogChanged('product-updated');
    res.json({ success: true });
}));

app.patch('/api/admin/products/:barcode/quantity', needAdmin, wrap(async (req, res) => {
    const qty = Math.max(0, parseInt(req.body.quantity, 10) || 0);
    if (!(await get('SELECT 1 FROM products WHERE barcode=?', [req.params.barcode]))) return res.status(404).json({ message: 'Product not found' });
    await stock.setStock(req.params.barcode, qty, req.user.name, 'quantity changed in admin');
    catalogChanged('stock');
    res.json({ success: true, barcode: req.params.barcode, quantity: qty });
}));

app.delete('/api/admin/products/:barcode', needAdmin, wrap(async (req, res) => {
    await run('DELETE FROM products WHERE barcode=?', [req.params.barcode]);
    catalogChanged('product-removed');
    res.json({ success: true });
}));

const ORDER_SELECT = `SELECT o.*, pu.name picker_name, ru.name rider_name, ru.phone rider_phone,
    CASE WHEN date(o.created_at) < date('now','localtime') AND o.status NOT IN ('Delivered','Cancelled') THEN 1 ELSE 0 END carried_over
    FROM orders o LEFT JOIN users pu ON pu.id=o.picker_id LEFT JOIN users ru ON ru.id=o.rider_id`;
app.get('/api/admin/orders', needAdmin, wrap(async (req, res) => {
    const scope = req.query.scope === 'history' ? 'history' : 'today';
    const q = `%${String(req.query.q || '').trim()}%`, from = req.query.from, to = req.query.to;
    let where, params = [];
    if (scope === 'today') where = `(date(o.created_at)=date('now','localtime') OR o.status NOT IN ('Delivered','Cancelled'))`;
    else {
        where = `(date(o.created_at) < date('now','localtime') AND o.status IN ('Delivered','Cancelled'))`;
        if (from) { where += ' AND date(o.created_at) >= ?'; params.push(from); }
        if (to) { where += ' AND date(o.created_at) <= ?'; params.push(to); }
    }
    if (q !== '%%') { where += ' AND (o.id LIKE ? OR o.customer_name LIKE ? OR o.customer_email LIKE ? OR o.customer_phone LIKE ?)'; params.push(q, q, q, q); }
    res.json(await all(`${ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC, o.rowid DESC LIMIT 300`, params));
}));

app.post('/api/admin/orders/:id/assign', needAdmin, wrap(async (req, res) => {
    const o = await get('SELECT * FROM orders WHERE id=?', [req.params.id]);
    if (!o) return res.status(404).json({ message: 'Order not found' });
    const pid = req.body.picker_id ? Number(req.body.picker_id) : o.picker_id, rid = req.body.rider_id ? Number(req.body.rider_id) : o.rider_id;
    await run('UPDATE orders SET picker_id=?, rider_id=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [pid, rid, o.id]);
    broadcast('order:update', { id: o.id, status: o.status }, toOwnerAndAdmins(o.customer_email));
    res.json({ success: true });
}));

// customer: live tracking data (rider position only while the order is out for delivery)
app.get('/api/orders/:id/track', needUser, wrap(async (req, res) => {
    const o = await get(`${ORDER_SELECT} WHERE o.id=? AND o.customer_email=?`, [req.params.id, req.user.email]);
    if (!o) return res.status(404).json({ message: 'Order not found' });
    let rider = null;
    if (o.status === 'Dispatched' && o.rider_id) {
        const loc = await get('SELECT lat,lng,updated_at FROM rider_locations WHERE user_id=?', [o.rider_id]);
        rider = { name: o.rider_name, phone: o.rider_phone, lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, updated_at: loc ? loc.updated_at : null };
    }
    res.json({ id: o.id, status: o.status, otp: o.status === 'Delivered' || o.status === 'Cancelled' ? null : o.otp, rider,
               dest: o.dest_lat != null ? { lat: o.dest_lat, lng: o.dest_lng } : null });
}));

app.patch('/api/admin/orders/:id/status', needAdmin, wrap(async (req, res) => {
    const status = req.body.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    if (status === 'Cancelled') {
        const r = await cancelOrder(req.params.id, null);
        return res.status(r.code).json(r.code === 200 ? { message: 'Order cancelled, stock returned' } : { message: r.message });
    }
    const o = await get('SELECT * FROM orders WHERE id=?', [req.params.id]);
    if (!o) return res.status(404).json({ message: 'Order not found' });
    if (o.status === 'Cancelled') return res.status(400).json({ message: 'Cancelled orders cannot be changed' });
    const stamp = { Picking: 'picked_at', Packed: 'packed_at', Dispatched: 'dispatched_at', Delivered: 'delivered_at' }[status];
    await run(`UPDATE orders SET status=?, updated_at=datetime('now','localtime')${stamp ? `, ${stamp}=datetime('now','localtime')` : ''} WHERE id=?`, [status, req.params.id]);
    broadcast('order:update', { id: o.id, status }, toOwnerAndAdmins(o.customer_email));     // customer's tracking screen moves instantly
    if (status === 'Dispatched' || status === 'Delivered') notifyOrder(o.id, status);
    res.json({ message: 'Status updated' });
}));

app.get('/api/admin/customers', needAdmin, wrap(async (req, res) => {
    res.json(await all(`SELECT u.id,u.name,u.email,u.phone,u.created_at,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_email=u.email) orders,
        (SELECT COALESCE(SUM(total_amount),0) FROM orders o WHERE o.customer_email=u.email AND o.status!='Cancelled') spent
        FROM users u WHERE u.role='customer' ORDER BY u.id DESC`));
}));

const ctx = { couponDiscount, app, run, get, all, wrap, needAdmin, needUser, needStaff, needPicker, needRider, broadcast, catalogChanged, toAdmins, toOwnerAndAdmins, stock, bcrypt, jwt, JWT_SECRET, upload, createProduct, shape,
    settings, bustSettings, makeSlots, notify, notifyOrder, announceNewOrder, createRefund, cancelOrder, payments, push, backup, invoiceHtml, tooMany, failed, auth };
require('./routes-staff')(ctx);
require('./routes-extra')(ctx);

app.use('/api', (req, res) => res.status(404).json({ message: 'Unknown API route' }));

setInterval(() => stock.refreshAll().then(n => { if (n) catalogChanged('expiry'); }).catch(() => {}), 5 * 60 * 1000);   // expired stock stops being sellable by itself
stock.refreshAll().catch(() => {});

process.on('uncaughtException', e => console.error('❌ Crash:', e));
process.on('unhandledRejection', e => console.error('❌ Unhandled:', e));
function onListenError(err) {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use (another copy of the server is running).`);
        console.error('   Close the other terminal, or run:  netstat -ano | findstr :' + PORT + '   then   taskkill /PID <number> /F');
        console.error('   Or use another port:  $env:PORT=3001; node server.js\n');
    } else console.error('\n❌ Server could not start:', err.message, '\n');
    process.exit(1);
}
const secure = !!(process.env.SSL_KEY && process.env.SSL_CERT);       // optional built-in HTTPS (or put Caddy / nginx / your host in front)
const server = (secure ? require('https').createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, app) : require('http').createServer(app))
    .listen(PORT, err => {
        if (err) return onListenError(err);
        console.log(`🚀 Groco running →  Store: ${secure ? 'https' : 'http'}://localhost:${PORT}   Admin: /admin.html   Staff: /staff.html`);
    });
server.on('error', onListenError);
