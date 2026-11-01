// setup-db.js — creates the database and fills it from data/catalog.json
//   node setup-db.js            create missing tables, seed only what is empty
//   node setup-db.js --reset    wipe everything and rebuild (deletes orders/customers too!)
//   node setup-db.js --catalog  reload ONLY products + stock batches (keeps customers, staff & orders)
require('./lib/env')();                                   // loads .env (Razorpay keys, SMS keys, etc.)
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const RESET = process.argv.includes('--reset');
const CATALOG_ONLY = process.argv.includes('--catalog');
const db = new sqlite3.Database(path.join(__dirname, 'groco.db'));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

const NOW = `(datetime('now','localtime'))`;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

function ean13(n) {
    const base = '890' + String(n).padStart(9, '0');
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
    return base + ((10 - (sum % 10)) % 10);
}
const SHELF_DAYS = { vegetables: 5, fruits: 7, 'dairy-eggs': 9, bakery: 4, 'icecream-frozen': 150, 'frozen-food': 150,
    'biscuits-cookies': 150, 'chocolates-sweets': 240, 'snacks-namkeen': 120, 'drinks-beverages': 200, 'tea-coffee': 365,
    'atta-flour': 150, 'rice-grains': 365, 'dal-pulses': 365, 'oil-ghee': 300, 'spices-masala': 365, 'sugar-sweeteners': 540,
    'sauces-spreads': 300, 'instant-packaged': 240, 'dry-fruits': 200, 'personal-care': 700, 'cleaning-household': 700,
    'paper-disposable': 900, 'baby-care': 500, 'pet-supplies': 300 };
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

(async () => {
    try {
        const old = await all(`PRAGMA table_info(products)`);
        const oldUsers = await all(`PRAGMA table_info(users)`);
        if (!RESET && ((old.length && !old.some(c => c.name === 'product_id')) || (oldUsers.length && !oldUsers.some(c => c.name === 'active')))) {
            console.log('\n⚠  Database from an older version found. Run:  node setup-db.js --reset\n');
            return;
        }
        if (RESET) for (const t of ['po_items', 'purchase_orders', 'suppliers', 'ratings', 'leaves', 'push_subs', 'password_resets', 'cash_settlements', 'issues', 'refunds', 'outbox', 'settings', 'payroll_paid', 'rider_locations', 'stock_counts', 'stock_log', 'batches', 'attendance', 'addresses', 'products', 'categories', 'orders', 'employees', 'users']) await run(`DROP TABLE IF EXISTS ${t}`);
        if (CATALOG_ONLY) { for (const t of ['batches', 'products', 'categories']) await run(`DELETE FROM ${t}`); }
        // (CREATE statements below are skipped for tables that already exist; new columns are added by ensureCols)

        await run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, phone TEXT,
            role TEXT DEFAULT 'customer', active INTEGER DEFAULT 1, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE NOT NULL, shift_start TEXT DEFAULT '09:00', shift_end TEXT DEFAULT '17:00',
            monthly_salary REAL DEFAULT 0, join_date TEXT, status TEXT DEFAULT 'Active')`);
        await run(`CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, day TEXT NOT NULL, punch_in TEXT, punch_out TEXT,
            late_min INTEGER DEFAULT 0, UNIQUE(user_id, day))`);
        await run(`CREATE TABLE IF NOT EXISTS payroll_paid (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, month TEXT NOT NULL, amount REAL, paid_at DATETIME DEFAULT ${NOW}, UNIQUE(user_id, month))`);
        await run(`CREATE TABLE IF NOT EXISTS rider_locations (user_id INTEGER PRIMARY KEY, lat REAL, lng REAL, updated_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, label TEXT, line TEXT NOT NULL, phone TEXT,
            lat REAL, lng REAL, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, image TEXT, subcategories TEXT DEFAULT '[]', sort_order INTEGER DEFAULT 0)`);
        await run(`CREATE TABLE IF NOT EXISTS products (
            barcode TEXT PRIMARY KEY, product_id TEXT, title TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT, brand TEXT,
            variant TEXT NOT NULL, price REAL NOT NULL, oldPrice REAL, image TEXT, description TEXT, rating TEXT,
            quantity INTEGER DEFAULT 0, inStock INTEGER DEFAULT 1, isBestSeller INTEGER DEFAULT 0, isFreshPick INTEGER DEFAULT 0,
            isDailyEssential INTEGER DEFAULT 0, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT NOT NULL, batch_no TEXT, qty INTEGER DEFAULT 0, received_qty INTEGER DEFAULT 0,
            expiry_date TEXT, received_at DATETIME DEFAULT ${NOW}, received_by TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS stock_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT, title TEXT, type TEXT, qty_change INTEGER, reason TEXT, batch_id INTEGER,
            user_name TEXT, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS stock_counts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, mode TEXT, barcode TEXT, title TEXT, expected INTEGER, counted INTEGER,
            diff INTEGER, note TEXT, user_name TEXT, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY, customer_email TEXT, customer_name TEXT, customer_phone TEXT, address TEXT, dest_lat REAL, dest_lng REAL,
            items TEXT, total_amount REAL, discount REAL DEFAULT 0, payment_mode TEXT, status TEXT DEFAULT 'Placed', otp TEXT,
            picker_id INTEGER, rider_id INTEGER, created_at DATETIME DEFAULT ${NOW}, picked_at TEXT, packed_at TEXT, dispatched_at TEXT,
            delivered_at TEXT, updated_at DATETIME DEFAULT ${NOW})`);
        for (const [n, sql] of [['idx_orders_email', 'orders(customer_email)'], ['idx_orders_status', 'orders(status)'], ['idx_orders_created', 'orders(created_at)'],
            ['idx_products_cat', 'products(category)'], ['idx_batches_bc', 'batches(barcode)'], ['idx_addr_user', 'addresses(user_id)']])
            await run(`CREATE INDEX IF NOT EXISTS ${n} ON ${sql}`);

        // ---- v4 tables: settings, payments, refunds, cash, resets, push, purchasing, ratings, leaves ----
        await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, channel TEXT, subject TEXT, body TEXT, status TEXT, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, amount REAL NOT NULL, reason TEXT, status TEXT DEFAULT 'pending',
            method TEXT, note TEXT, created_at DATETIME DEFAULT ${NOW}, processed_at TEXT, processed_by TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS issues (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, barcode TEXT, title TEXT, qty INTEGER, reason TEXT, note TEXT,
            status TEXT DEFAULT 'open', refund_amount REAL DEFAULT 0, admin_note TEXT, created_at DATETIME DEFAULT ${NOW}, resolved_by TEXT, resolved_at TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS cash_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, rider_id INTEGER NOT NULL, amount REAL, received_by TEXT, note TEXT, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS password_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`);
        await run(`CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, notes TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, status TEXT DEFAULT 'sent', note TEXT, created_by TEXT,
            created_at DATETIME DEFAULT ${NOW}, received_at TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS po_items (id INTEGER PRIMARY KEY AUTOINCREMENT, po_id INTEGER NOT NULL, barcode TEXT NOT NULL, title TEXT, qty INTEGER, cost REAL DEFAULT 0, qty_received INTEGER DEFAULT 0, expiry_date TEXT)`);
        await run(`CREATE TABLE IF NOT EXISTS ratings (order_id TEXT PRIMARY KEY, rider_id INTEGER, stars INTEGER, comment TEXT, created_at DATETIME DEFAULT ${NOW})`);
        await run(`CREATE TABLE IF NOT EXISTS leaves (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, from_date TEXT, to_date TEXT, reason TEXT, status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT ${NOW}, decided_by TEXT)`);
        const ensureCols = async (table, cols) => {
            const have = (await all(`PRAGMA table_info(${table})`)).map(c => c.name);
            for (const [n, ddl] of cols) if (!have.includes(n)) await run(`ALTER TABLE ${table} ADD COLUMN ${n} ${ddl}`);
        };
        await ensureCols('orders', [['subtotal', 'REAL'], ['delivery_fee', 'REAL DEFAULT 0'], ['payment_status', "TEXT DEFAULT 'cod'"], ['rzp_order_id', 'TEXT'], ['rzp_payment_id', 'TEXT'],
            ['slot_label', 'TEXT'], ['slot_at', 'TEXT'], ['coupon', 'TEXT'], ['adjustments', 'TEXT'], ['cash_collected', 'REAL DEFAULT 0'], ['settlement_id', 'INTEGER'], ['refunded', 'REAL DEFAULT 0']]);
        await ensureCols('products', [['reorder_level', 'INTEGER DEFAULT 10'], ['reorder_qty', 'INTEGER DEFAULT 50'], ['supplier_id', 'INTEGER'], ['cost_price', 'REAL']]);
        const DEFAULTS = { min_order: '99', delivery_fee: '25', free_delivery_above: '299', delivery_gst: '18', serviceable_pincodes: '', store_open: '08:00', store_close: '22:00',
            slots_enabled: '1', store_name: 'Groco', store_address: 'Kopar West, Thane, Maharashtra', store_gstin: '', store_phone: '', auto_reorder: '0',
            gst_rates: JSON.stringify({ vegetables: 0, fruits: 0, 'dairy-eggs': 5, 'biscuits-cookies': 18, 'chocolates-sweets': 18, 'icecream-frozen': 18, 'snacks-namkeen': 12, 'drinks-beverages': 18,
                'tea-coffee': 5, 'atta-flour': 0, 'rice-grains': 0, 'dal-pulses': 0, 'oil-ghee': 5, 'spices-masala': 5, 'sugar-sweeteners': 5, 'sauces-spreads': 12, 'instant-packaged': 12,
                'frozen-food': 12, bakery: 5, 'dry-fruits': 12, 'personal-care': 18, 'cleaning-household': 18, 'paper-disposable': 12, 'baby-care': 12, 'pet-supplies': 18 }) };
        for (const [k, v] of Object.entries(DEFAULTS)) await run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', [k, v]);

        // ---- accounts ----
        const mk = async (name, email, pw, phone, role, shift, salary) => {
            if (await get('SELECT id FROM users WHERE email=?', [email])) return;
            const r = await run(`INSERT INTO users (name,email,password,phone,role) VALUES (?,?,?,?,?)`, [name, email, await bcrypt.hash(pw, 10), phone, role]);
            if (role !== 'admin') await run(`INSERT INTO employees (user_id,shift_start,shift_end,monthly_salary,join_date) VALUES (?,?,?,?,?)`, [r.lastID, shift[0], shift[1], salary, ymd(new Date())]);
        };
        const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
        await mk('Admin', 'admin@groco.com', adminPw, '+91 9999999999', 'admin');
        await mk('Amit Verma (Picker)', 'picker@groco.com', 'picker123', '9811223344', 'picker', ['09:00', '18:00'], 18000);
        await mk('Rahul Sharma (Rider)', 'rider@groco.com', 'rider123', '9876543210', 'rider', ['09:00', '18:00'], 16000);
        console.log(`Admin:  admin@groco.com / ${adminPw}\nPicker: picker@groco.com / picker123\nRider:  rider@groco.com / rider123   (demo staff — change or delete later)`);

        // ---- catalog ----
        const file = path.join(__dirname, 'data', 'catalog.json');
        if (!fs.existsSync(file)) throw new Error('data/catalog.json not found');
        const { categories, products } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!(await get(`SELECT 1 FROM categories LIMIT 1`))) {
            let i = 0;
            for (const c of categories) await run(`INSERT INTO categories (id,name,icon,image,subcategories,sort_order) VALUES (?,?,?,?,?,?)`,
                [c.id, c.name, c.icon, c.image, JSON.stringify(c.subcategories || []), i++]);
        }
        if (!(await get(`SELECT 1 FROM products LIMIT 1`))) {
            let n = 1, rows = 0, bn = 1;
            await run('BEGIN');
            for (const p of products) {
                for (const v of p.variants) {
                    const stock = Number.isFinite(p.stock) ? p.stock : 50, bc = ean13(n++), h = hash(bc);
                    await run(`INSERT INTO products (barcode,product_id,title,category,subcategory,brand,variant,price,oldPrice,image,description,rating,quantity,inStock,isBestSeller,isFreshPick,isDailyEssential)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [bc, p.id, p.title, p.category, p.subcategory || 'General', p.brand || 'Groco', v.unit, v.price, v.oldPrice || v.price,
                         p.image || '', p.description || '', p.rating || '', stock, stock > 0 ? 1 : 0,
                         p.isBestSeller ? 1 : 0, p.isFreshPick ? 1 : 0, p.isDailyEssential ? 1 : 0]);
                    const shelf = SHELF_DAYS[p.category] || 300;
                    const exp = addDays(Math.max(2, Math.round(shelf * (0.35 + 0.65 * ((h % 100) / 100)))));
                    await run(`INSERT INTO batches (barcode,batch_no,qty,received_qty,expiry_date,received_by) VALUES (?,?,?,?,?,'seed')`, [bc, 'B' + String(bn++).padStart(5, '0'), stock, stock, exp]);
                    if (h % 17 === 0) await run(`INSERT INTO batches (barcode,batch_no,qty,received_qty,expiry_date,received_by) VALUES (?,?,?,?,?,'seed')`, [bc, 'B' + String(bn++).padStart(5, '0'), 4, 4, addDays(-1)]);
                    rows++;
                }
            }
            await run('COMMIT');
            console.log(`Products: ${products.length} items → ${rows} sellable sizes (with stock batches & expiry dates)`);
        }
        console.log('\n✅ Database ready. Start the app with:  node server.js');
    } catch (e) {
        console.error('Setup failed:', e.message);
        try { await run('ROLLBACK'); } catch (_) {}
    } finally { db.close(); }
})();
