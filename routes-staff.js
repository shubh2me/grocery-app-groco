// Staff (picker + rider) app, attendance, payroll, inventory control, and admin staff management.
module.exports = function (ctx) {
    const { app, run, get, all, wrap, needAdmin, needStaff, needPicker, needRider, broadcast, catalogChanged, toAdmins, toOwnerAndAdmins, stock, bcrypt, upload, createProduct, notify, notifyOrder, createRefund, cancelOrder, push, couponDiscount } = ctx;
    const pad = n => String(n).padStart(2, '0');
    const nowStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const today = stock.today;
    const monthNow = () => today().slice(0, 7);
    const parseLocal = s => new Date(String(s).replace(' ', 'T'));
    const mins = hhmm => { const [h, m] = String(hhmm || '09:00').split(':').map(Number); return h * 60 + m; };
    const validHHMM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
    const mw = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ message: 'Server error' }); });

    // loads the logged-in staff member and blocks deactivated accounts
    const loadMe = mw(async (req, res, next) => {
        const u = await get(`SELECT u.id,u.name,u.email,u.phone,u.role,u.active,e.shift_start,e.shift_end,e.monthly_salary,e.status
                             FROM users u LEFT JOIN employees e ON e.user_id=u.id WHERE u.id=?`, [req.user.id]);
        if (!u || u.active === 0) return res.status(403).json({ message: 'This account is deactivated' });
        req.me = u; next();
    });
    // real shifts: you must be punched in to take or change work
    const punched = mw(async (req, res, next) => {
        if (req.user.role === 'admin') return next();
        const r = await get('SELECT * FROM attendance WHERE user_id=? AND day=?', [req.user.id, today()]);
        if (!r || !r.punch_in || r.punch_out) return res.status(403).json({ message: 'Punch in first to start your shift', needPunch: true });
        next();
    });
    const S = (...h) => [needStaff, loadMe, ...h];
    const P = (...h) => [needPicker, loadMe, ...h];
    const R = (...h) => [needRider, loadMe, ...h];
    const who = req => req.me ? req.me.name : req.user.name;

    // ---------- payroll maths (used by staff page and admin) ----------
    async function payFor(userId, month) {
        const e = await get('SELECT * FROM employees WHERE user_id=?', [userId]) || { monthly_salary: 0, shift_start: '09:00', shift_end: '17:00' };
        const rows = await all('SELECT * FROM attendance WHERE user_id=? AND day LIKE ? ORDER BY day DESC', [userId, month + '%']);
        const shiftHours = Math.max(1, (mins(e.shift_end) - mins(e.shift_start)) / 60);
        let hours = 0, ot = 0;
        for (const r of rows) if (r.punch_in) {
            const end = r.punch_out ? parseLocal(r.punch_out) : new Date(); const h = (end - parseLocal(r.punch_in)) / 3.6e6;
            if (h > 0) { hours += h; if (r.punch_out && h - shiftHours >= 0.25) ot += h - shiftHours; }      // overtime counts after a finished shift, from 15 minutes over
        }
        const present = new Set(rows.filter(r => r.punch_in).map(r => r.day)), leaveDays = new Set();
        for (const l of await all(`SELECT * FROM leaves WHERE user_id=? AND status='approved' AND from_date<=? AND to_date>=?`, [userId, month + '-31', month + '-01']))
            for (let d = new Date(l.from_date + 'T00:00:00'), i = 0; d <= new Date(l.to_date + 'T00:00:00') && i < 62; d.setDate(d.getDate() + 1), i++) {
                const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                if (ds.startsWith(month) && !present.has(ds)) leaveDays.add(ds);
            }
        const days = present.size, daily = (e.monthly_salary || 0) / 26, base = Math.round(daily * Math.min(days + leaveDays.size, 26));
        const otPay = Math.round(ot * (daily / shiftHours) * 1.5);
        const paid = await get('SELECT amount, paid_at FROM payroll_paid WHERE user_id=? AND month=?', [userId, month]);
        return { month, monthly_salary: e.monthly_salary || 0, daily_rate: Math.round(daily), days, leave_days: leaveDays.size, hours: +hours.toFixed(1), overtime_hours: +ot.toFixed(1), overtime_pay: otPay,
                 late: rows.filter(r => r.late_min > 0).length, earned: base + otPay, paid: paid || null, rows };
    }

    // ---------- profile + attendance ----------
    app.get('/api/staff/me', ...S(wrap(async (req, res) => {
        const att = await get('SELECT * FROM attendance WHERE user_id=? AND day=?', [req.user.id, today()]);
        const active = req.me.role === 'rider'
            ? (await get(`SELECT COUNT(*) n FROM orders WHERE rider_id=? AND status='Dispatched'`, [req.user.id])).n
            : (await get(`SELECT COUNT(*) n FROM orders WHERE picker_id=? AND status='Picking'`, [req.user.id])).n;
        res.json({ user: { id: req.me.id, name: req.me.name, email: req.me.email, phone: req.me.phone, role: req.me.role },
                   shift: { start: req.me.shift_start, end: req.me.shift_end }, today: att || null,
                   onShift: !!(att && att.punch_in && !att.punch_out), activeJobs: active, pay: await payFor(req.user.id, monthNow()),
                   rating: req.me.role === 'rider' ? await get('SELECT ROUND(AVG(stars),1) avg, COUNT(*) n FROM ratings WHERE rider_id=?', [req.user.id]) : null,
                   cash: req.me.role === 'rider' ? (await get(`SELECT COALESCE(SUM(cash_collected),0) amt FROM orders WHERE rider_id=? AND status='Delivered' AND settlement_id IS NULL AND payment_mode='COD'`, [req.user.id])).amt : 0 });
    })));

    app.post('/api/staff/punch', ...S(wrap(async (req, res) => {
        const att = await get('SELECT * FROM attendance WHERE user_id=? AND day=?', [req.user.id, today()]);
        const d = new Date(), nowMin = d.getHours() * 60 + d.getMinutes();
        let action;
        if (!att) {
            const late = Math.max(0, nowMin - (mins(req.me.shift_start) + 10));      // 10 minutes grace
            await run('INSERT INTO attendance (user_id,day,punch_in,late_min) VALUES (?,?,?,?)', [req.user.id, today(), nowStr(), late]);
            action = 'in';
        } else if (!att.punch_out) {
            const busy = req.me.role === 'rider'
                ? (await get(`SELECT COUNT(*) n FROM orders WHERE rider_id=? AND status='Dispatched'`, [req.user.id])).n
                : (await get(`SELECT COUNT(*) n FROM orders WHERE picker_id=? AND status='Picking'`, [req.user.id])).n;
            if (busy) return res.status(400).json({ message: 'Finish your current orders before punching out' });
            await run('UPDATE attendance SET punch_out=? WHERE id=?', [nowStr(), att.id]);
            action = 'out';
        } else return res.status(400).json({ message: "You've already completed today's shift" });
        broadcast('attendance', { user_id: req.user.id, name: req.me.name, role: req.me.role, action, time: nowStr() }, toAdmins);
        res.json({ action, today: await get('SELECT * FROM attendance WHERE user_id=? AND day=?', [req.user.id, today()]) });
    })));

    app.get('/api/staff/salary', ...S(wrap(async (req, res) => {
        const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthNow();
        res.json(await payFor(req.user.id, month));
    })));

    // ---------- PICKER: orders ----------
    app.get('/api/staff/pick-queue', ...P(wrap(async (req, res) => {
        const cats = Object.fromEntries((await all('SELECT id,name FROM categories')).map(c => [c.id, c.name]));
        const orders = await all(`SELECT o.id,o.customer_name,o.status,o.items,o.created_at,o.picker_id,o.slot_label,o.slot_at,o.adjustments,pu.name picker_name
            FROM orders o LEFT JOIN users pu ON pu.id=o.picker_id WHERE o.status IN ('Placed','Picking') AND o.payment_status IN ('cod','paid') ORDER BY COALESCE(o.slot_at, o.created_at) ASC`);
        for (const o of orders) {
            o.mine = o.picker_id === req.user.id;
            o.items = JSON.parse(o.items || '[]');
            for (const it of o.items) {
                const p = await get('SELECT category,subcategory FROM products WHERE barcode=?', [it.barcode]);
                it.aisle = p ? `${cats[p.category] || p.category}${p.subcategory ? ' › ' + p.subcategory : ''}` : '-';
            }
            o.items.sort((a, b) => a.aisle.localeCompare(b.aisle));          // walk the store in aisle order
        }
        res.json(orders);
    })));
    const statusChanged = (o, status) => broadcast('order:update', { id: o.id, status }, toOwnerAndAdmins(o.customer_email));
    app.post('/api/staff/orders/:id/pick-start', ...P(punched, wrap(async (req, res) => {
        const r = await run(`UPDATE orders SET status='Picking', picker_id=?, picked_at=?, updated_at=? WHERE id=? AND status='Placed' AND payment_status IN ('cod','paid')`, [req.user.id, nowStr(), nowStr(), req.params.id]);
        if (!r.changes) return res.status(409).json({ message: 'Someone else already took this order' });
        statusChanged(await get('SELECT * FROM orders WHERE id=?', [req.params.id]), 'Picking');
        res.json({ success: true });
    })));
    app.post('/api/staff/orders/:id/packed', ...P(punched, wrap(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const r = await run(`UPDATE orders SET status='Packed', packed_at=?, updated_at=? WHERE id=? AND status='Picking' AND (picker_id=? OR ?)`, [nowStr(), nowStr(), req.params.id, req.user.id, isAdmin ? 1 : 0]);
        if (!r.changes) return res.status(409).json({ message: 'This order is not yours to pack' });
        const o = await get('SELECT * FROM orders WHERE id=?', [req.params.id]);
        statusChanged(o, 'Packed');
        broadcast('delivery:available', { id: o.id }, u => u && ['rider', 'admin'].includes(u.role));
        push.toRole('rider', { title: '📦 Order ready for delivery', body: `${o.id} is packed and waiting at the store`, url: '/staff.html' }).catch(() => {});
        res.json({ success: true });
    })));
    app.post('/api/staff/orders/:id/release', ...P(punched, wrap(async (req, res) => {
        const r = await run(`UPDATE orders SET status='Placed', picker_id=NULL, updated_at=? WHERE id=? AND status='Picking' AND picker_id=?`, [nowStr(), req.params.id, req.user.id]);
        if (!r.changes) return res.status(409).json({ message: 'Cannot release this order' });
        statusChanged(await get('SELECT * FROM orders WHERE id=?', [req.params.id]), 'Placed');
        res.json({ success: true });
    })));

    // item not on the shelf: remove it from the order, reduce the bill, refund if already paid, tell the customer
    app.post('/api/staff/orders/:id/missing', ...P(punched, wrap(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const o = await get(`SELECT * FROM orders WHERE id=? AND status='Picking' AND (picker_id=? OR ?)`, [req.params.id, req.user.id, isAdmin ? 1 : 0]);
        if (!o) return res.status(409).json({ message: 'You can only do this on an order you are picking' });
        const items = JSON.parse(o.items || '[]'), i = items.findIndex(x => x.barcode === req.body.barcode);
        if (i < 0) return res.status(404).json({ message: 'Item not in this order' });
        const it = items[i], qty = Math.min(it.qty, Math.max(1, parseInt(req.body.qty, 10) || it.qty));
        const adj = JSON.parse(o.adjustments || '[]'); adj.push({ title: it.title, variant: it.variant, qty, price: it.price, reason: 'out of stock at the store' });
        it.qty -= qty; if (it.qty <= 0) items.splice(i, 1);
        await stock.log('pick_missing', req.body.barcode, 0, `order ${o.id}: ${qty} not found on the shelf (please count this item)`, null, who(req));
        const subtotal = items.reduce((t, l) => t + l.price * l.qty, 0), discount = o.coupon ? couponDiscount(o.coupon, subtotal) : 0, total = items.length ? subtotal - discount + (o.delivery_fee || 0) : 0;
        const diff = Math.round((o.total_amount - total) * 100) / 100;
        await run('UPDATE orders SET items=?, subtotal=?, discount=?, total_amount=?, adjustments=?, updated_at=? WHERE id=?', [JSON.stringify(items), subtotal, discount, items.length ? total : o.total_amount, JSON.stringify(adj), nowStr(), o.id]);
        if (!items.length) { await cancelOrder(o.id, null, 'all items unavailable'); return res.json({ success: true, cancelled: true }); }
        if (o.payment_status === 'paid' && diff > 0) await createRefund(o.id, diff, `unavailable: ${it.title}`);
        statusChanged(o, 'Picking');
        const u = await get('SELECT phone,email FROM users WHERE email=?', [o.customer_email]);
        notify.send({ phone: o.customer_phone || (u && u.phone), email: o.customer_email }, `Groco: sorry, ${it.title} (${it.variant}) was out of stock for order ${o.id}. Your bill is now ₹${total}${o.payment_status === 'paid' ? `; ₹${diff} will be refunded` : ''}.`, `Order ${o.id} updated`).catch(() => {});
        res.json({ success: true, total, refund: o.payment_status === 'paid' ? diff : 0 });
    })));

    // ---------- RIDER: deliveries ----------
    app.get('/api/staff/deliveries', ...R(wrap(async (req, res) => {
        const cols = 'id,customer_name,customer_phone,address,dest_lat,dest_lng,total_amount,payment_mode,payment_status,slot_label,slot_at,items,packed_at,dispatched_at,status';
        const fix = rows => rows.map(o => ({ ...o, item_count: JSON.parse(o.items || '[]').reduce((n, i) => n + i.qty, 0), items: undefined }));
        res.json({
            available: fix(await all(`SELECT ${cols} FROM orders WHERE status='Packed' AND rider_id IS NULL ORDER BY COALESCE(slot_at, packed_at) ASC`)),
            mine: fix(await all(`SELECT ${cols} FROM orders WHERE status='Dispatched' AND rider_id=? ORDER BY dispatched_at ASC`, [req.user.id]))
        });
    })));
    app.post('/api/staff/orders/:id/accept', ...R(punched, wrap(async (req, res) => {
        const mine = (await get(`SELECT COUNT(*) n FROM orders WHERE rider_id=? AND status='Dispatched'`, [req.user.id])).n;
        if (mine >= 3) return res.status(400).json({ message: 'You already have 3 deliveries. Finish one first.' });
        const r = await run(`UPDATE orders SET status='Dispatched', rider_id=?, dispatched_at=?, updated_at=? WHERE id=? AND status='Packed' AND rider_id IS NULL`, [req.user.id, nowStr(), nowStr(), req.params.id]);
        if (!r.changes) return res.status(409).json({ message: 'Another rider already took this order' });
        statusChanged(await get('SELECT * FROM orders WHERE id=?', [req.params.id]), 'Dispatched');
        notifyOrder(req.params.id, 'Dispatched', { rider: req.me.name.replace(/\s*\(.*\)/, '') });
        res.json({ success: true });
    })));
    app.post('/api/staff/orders/:id/deliver', ...R(punched, wrap(async (req, res) => {
        const o = await get(`SELECT * FROM orders WHERE id=? AND rider_id=? AND status='Dispatched'`, [req.params.id, req.user.id]);
        if (!o) return res.status(404).json({ message: 'Order not found in your deliveries' });
        if (String(req.body.otp || '').trim() !== String(o.otp)) return res.status(400).json({ message: 'Wrong delivery code. Ask the customer for the 4-digit code.' });
        await run(`UPDATE orders SET status='Delivered', delivered_at=?, updated_at=?, cash_collected=? WHERE id=?`, [nowStr(), nowStr(), o.payment_mode === 'COD' ? o.total_amount : 0, o.id]);
        statusChanged(o, 'Delivered'); notifyOrder(o.id, 'Delivered');
        res.json({ success: true, collect: o.payment_mode === 'COD' ? o.total_amount : 0 });
    })));
    app.post('/api/staff/location', ...R(punched, wrap(async (req, res) => {
        const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ message: 'Bad location' });
        await run(`INSERT INTO rider_locations (user_id,lat,lng,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at`, [req.user.id, lat, lng, nowStr()]);
        broadcast('rider:pos', { rider_id: req.user.id, name: req.me.name, lat, lng }, toAdmins);
        for (const o of await all(`SELECT id,customer_email FROM orders WHERE rider_id=? AND status='Dispatched'`, [req.user.id]))
            broadcast('rider:location', { order_id: o.id, lat, lng }, u => u && u.email === o.customer_email);
        res.json({ success: true });
    })));

    // ---------- PICKER / ADMIN: inventory control ----------
    app.get('/api/staff/inventory', ...P(wrap(async (req, res) => {
        const q = `%${String(req.query.q || '').trim()}%`, cat = req.query.category;
        const rows = await all(`SELECT p.barcode,p.product_id,p.title,p.variant,p.brand,p.category,p.price,p.quantity sellable,
            (SELECT COALESCE(SUM(qty),0) FROM batches b WHERE b.barcode=p.barcode) on_hand,
            (SELECT MIN(expiry_date) FROM batches b WHERE b.barcode=p.barcode AND b.qty>0) next_expiry
            FROM products p WHERE (p.title LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ?) ${cat && cat !== 'all' ? 'AND p.category=?' : ''}
            ORDER BY p.category, p.title, p.rowid LIMIT 400`, cat && cat !== 'all' ? [q, q, q, cat] : [q, q, q]);
        res.json(rows);
    })));

    app.post('/api/staff/receive', ...P(punched, wrap(async (req, res) => {
        const qty = parseInt(req.body.qty, 10), bc = String(req.body.barcode || '');
        if (!(qty > 0 && qty <= 100000)) return res.status(400).json({ message: 'Enter how many units arrived' });
        if (!(await get('SELECT 1 FROM products WHERE barcode=?', [bc]))) return res.status(404).json({ message: 'Product not found' });
        const exp = String(req.body.expiry_date || '').trim();
        if (exp && !stock.validDate(exp)) return res.status(400).json({ message: 'Expiry date must look like 2026-12-31' });
        if (exp && exp < today()) return res.status(400).json({ message: 'That expiry date is already in the past' });
        await stock.addBatch(bc, qty, exp, String(req.body.batch_no || '').trim() || null, who(req));
        catalogChanged('stock');
        res.status(201).json({ success: true });
    })));

    app.post('/api/staff/products', ...P(punched, upload.single('imageFile'), wrap(async (req, res) => {
        const r = await createProduct(req.body, req.file, who(req));
        res.status(r.code).json(r.product || { message: r.message });
    })));

    app.get('/api/staff/expiry', ...P(wrap(async (req, res) => {
        const days = Math.max(1, Math.min(120, parseInt(req.query.days, 10) || 14));
        const lim = new Date(); lim.setDate(lim.getDate() + days);
        const limit = `${lim.getFullYear()}-${pad(lim.getMonth() + 1)}-${pad(lim.getDate())}`;
        const rows = await all(`SELECT b.id,b.barcode,b.batch_no,b.qty,b.expiry_date,p.title,p.variant,p.category
            FROM batches b JOIN products p ON p.barcode=b.barcode WHERE b.qty>0 AND b.expiry_date IS NOT NULL AND b.expiry_date<=? ORDER BY b.expiry_date ASC LIMIT 300`, [limit]);
        const t = today();
        for (const r of rows) r.days_left = Math.round((new Date(r.expiry_date) - new Date(t)) / 864e5);
        res.json({ expired: rows.filter(r => r.days_left < 0), soon: rows.filter(r => r.days_left >= 0) });
    })));

    app.post('/api/staff/writeoff', ...P(punched, wrap(async (req, res) => {
        const b = await get('SELECT * FROM batches WHERE id=? AND qty>0', [req.body.batch_id]);
        if (!b) return res.status(404).json({ message: 'Batch not found or already empty' });
        const qty = req.body.qty ? parseInt(req.body.qty, 10) : b.qty;
        if (!(qty > 0 && qty <= b.qty)) return res.status(400).json({ message: `Enter 1 to ${b.qty}` });
        const reason = ['expired', 'damaged', 'other'].includes(req.body.reason) ? req.body.reason : 'expired';
        await run('UPDATE batches SET qty=qty-? WHERE id=?', [qty, b.id]);
        await stock.log('writeoff', b.barcode, -qty, reason, b.id, who(req));
        await stock.recalc(b.barcode);
        catalogChanged('stock');
        res.json({ success: true });
    })));

    // cycle count (a few items) or full audit (many items): compare the shelf count with the system, fix stock, keep a record
    app.post('/api/staff/count', ...P(punched, wrap(async (req, res) => {
        const counts = Array.isArray(req.body.counts) ? req.body.counts.slice(0, 500) : [];
        if (!counts.length) return res.status(400).json({ message: 'Enter at least one count' });
        const mode = req.body.mode === 'audit' ? 'audit' : 'cycle', note = String(req.body.note || '').slice(0, 200);
        const session = 'CNT-' + Date.now().toString(36).toUpperCase(), out = [];
        for (const c of counts) {
            const counted = parseInt(c.counted, 10);
            if (!Number.isInteger(counted) || counted < 0) continue;
            const p = await get('SELECT title,variant FROM products WHERE barcode=?', [c.barcode]);
            if (!p) continue;
            const expected = await stock.onHand(c.barcode), diff = counted - expected;
            await run('INSERT INTO stock_counts (session,mode,barcode,title,expected,counted,diff,note,user_name) VALUES (?,?,?,?,?,?,?,?,?)',
                [session, mode, c.barcode, `${p.title} (${p.variant})`, expected, counted, diff, note, who(req)]);
            if (diff < 0) { await stock.deduct(c.barcode, -diff, true); await stock.log('count_adjust', c.barcode, diff, `${mode} ${session}`, null, who(req)); }
            else if (diff > 0) await stock.addBatch(c.barcode, diff, null, 'COUNT', who(req), 'count_adjust', `${mode} ${session}`);
            out.push({ barcode: c.barcode, title: `${p.title} (${p.variant})`, expected, counted, diff });
        }
        catalogChanged('stock');
        res.json({ session, mode, items: out, variance: out.reduce((n, i) => n + Math.abs(i.diff), 0), mismatched: out.filter(i => i.diff !== 0).length });
    })));
    app.get('/api/staff/counts', ...P(wrap(async (req, res) => res.json(await all('SELECT * FROM stock_counts ORDER BY id DESC LIMIT ?', [Math.min(500, parseInt(req.query.limit, 10) || 100)])))));
    app.get('/api/staff/stock-log', ...P(wrap(async (req, res) => res.json(await all('SELECT * FROM stock_log ORDER BY id DESC LIMIT ?', [Math.min(500, parseInt(req.query.limit, 10) || 100)])))));

    app.get('/api/staff/cash', ...R(wrap(async (req, res) => {
        const pending = await all(`SELECT id,total_amount,cash_collected,delivered_at FROM orders WHERE rider_id=? AND status='Delivered' AND payment_mode='COD' AND settlement_id IS NULL ORDER BY delivered_at DESC`, [req.user.id]);
        const history = await all('SELECT * FROM cash_settlements WHERE rider_id=? ORDER BY id DESC LIMIT 15', [req.user.id]);
        res.json({ owed: pending.reduce((n, o) => n + o.cash_collected, 0), pending, history });
    })));

    // ---------- leave requests ----------
    app.get('/api/staff/leaves', ...S(wrap(async (req, res) => res.json(await all('SELECT * FROM leaves WHERE user_id=? ORDER BY id DESC LIMIT 30', [req.user.id])))));
    app.post('/api/staff/leaves', ...S(wrap(async (req, res) => {
        const f = String(req.body.from_date || ''), t = String(req.body.to_date || f);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || t < f) return res.status(400).json({ message: 'Choose valid from and to dates' });
        if (f < today()) return res.status(400).json({ message: 'Leave must start today or later' });
        if ((new Date(t) - new Date(f)) / 864e5 > 30) return res.status(400).json({ message: 'Maximum 31 days per request' });
        await run('INSERT INTO leaves (user_id,from_date,to_date,reason) VALUES (?,?,?,?)', [req.user.id, f, t, String(req.body.reason || '').slice(0, 200)]);
        broadcast('leave:new', { name: req.me.name }, toAdmins);
        res.status(201).json({ success: true });
    })));
    app.get('/api/admin/leaves', needAdmin, wrap(async (req, res) => res.json(await all(`SELECT l.*, u.name, u.role FROM leaves l JOIN users u ON u.id=l.user_id ORDER BY (l.status='pending') DESC, l.id DESC LIMIT 100`))));
    app.post('/api/admin/leaves/:id/decide', needAdmin, wrap(async (req, res) => {
        if (!['approved', 'rejected'].includes(req.body.status)) return res.status(400).json({ message: 'Bad status' });
        await run('UPDATE leaves SET status=?, decided_by=? WHERE id=?', [req.body.status, req.user.name, req.params.id]); res.json({ success: true });
    }));

    // ---------- ADMIN: staff, attendance, payroll, live riders ----------
    app.get('/api/admin/staff', needAdmin, wrap(async (req, res) => {
        const rows = await all(`SELECT u.id,u.name,u.email,u.phone,u.role,u.active,e.shift_start,e.shift_end,e.monthly_salary,e.join_date,
            a.punch_in,a.punch_out,a.late_min,l.lat,l.lng,l.updated_at loc_at,
            (SELECT ROUND(AVG(stars),1) FROM ratings r WHERE r.rider_id=u.id) rating, (SELECT COUNT(*) FROM ratings r WHERE r.rider_id=u.id) rating_count
            FROM users u JOIN employees e ON e.user_id=u.id LEFT JOIN attendance a ON a.user_id=u.id AND a.day=?
            LEFT JOIN rider_locations l ON l.user_id=u.id WHERE u.role IN ('picker','rider') ORDER BY u.active DESC, u.role, u.name`, [today()]);
        res.json(rows.map(r => ({ ...r, state: !r.punch_in ? 'absent' : r.punch_out ? 'done' : 'on-shift' })));
    }));
    app.post('/api/admin/staff', needAdmin, wrap(async (req, res) => {
        const b = req.body, name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
        if (name.length < 2) return res.status(400).json({ message: 'Enter the staff name' });
        if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email (used to log in)' });
        if (!['picker', 'rider'].includes(b.role)) return res.status(400).json({ message: 'Role must be picker or rider' });
        if (String(b.password || '').length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
        const ss = b.shift_start || '09:00', se = b.shift_end || '17:00', sal = Math.max(0, parseFloat(b.monthly_salary) || 0);
        if (!validHHMM(ss) || !validHHMM(se)) return res.status(400).json({ message: 'Shift times must look like 09:00' });
        if (await get('SELECT 1 FROM users WHERE email=?', [email])) return res.status(400).json({ message: 'That email is already used' });
        const u = await run(`INSERT INTO users (name,email,password,phone,role) VALUES (?,?,?,?,?)`, [name, email, await bcrypt.hash(String(b.password), 10), String(b.phone || '').replace(/[^\d+]/g, ''), b.role]);
        await run(`INSERT INTO employees (user_id,shift_start,shift_end,monthly_salary,join_date) VALUES (?,?,?,?,?)`, [u.lastID, ss, se, sal, today()]);
        res.status(201).json({ id: u.lastID });
    }));
    app.patch('/api/admin/staff/:id', needAdmin, wrap(async (req, res) => {
        const u = await get(`SELECT u.*, e.shift_start, e.shift_end, e.monthly_salary FROM users u JOIN employees e ON e.user_id=u.id WHERE u.id=?`, [req.params.id]);
        if (!u) return res.status(404).json({ message: 'Staff member not found' });
        const b = { ...u, ...req.body };
        if (!validHHMM(b.shift_start) || !validHHMM(b.shift_end)) return res.status(400).json({ message: 'Shift times must look like 09:00' });
        await run('UPDATE employees SET shift_start=?, shift_end=?, monthly_salary=?, status=? WHERE user_id=?',
            [b.shift_start, b.shift_end, Math.max(0, parseFloat(b.monthly_salary) || 0), req.body.active === 0 ? 'Inactive' : 'Active', u.id]);
        await run('UPDATE users SET phone=?, active=? WHERE id=?', [String(b.phone || '').replace(/[^\d+]/g, ''), req.body.active === undefined ? u.active : (req.body.active ? 1 : 0), u.id]);
        if (req.body.password) { if (String(req.body.password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' }); await run('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(String(req.body.password), 10), u.id]); }
        res.json({ success: true });
    }));
    app.get('/api/admin/attendance', needAdmin, wrap(async (req, res) => {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
        res.json(await all(`SELECT u.id,u.name,u.role,e.shift_start,e.shift_end,a.punch_in,a.punch_out,COALESCE(a.late_min,0) late_min
            FROM users u JOIN employees e ON e.user_id=u.id LEFT JOIN attendance a ON a.user_id=u.id AND a.day=? WHERE u.role IN ('picker','rider') AND u.active=1 ORDER BY u.role,u.name`, [day]));
    }));
    app.get('/api/admin/payroll', needAdmin, wrap(async (req, res) => {
        const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthNow();
        const staff = await all(`SELECT u.id,u.name,u.role FROM users u JOIN employees e ON e.user_id=u.id WHERE u.role IN ('picker','rider') ORDER BY u.role,u.name`);
        const out = [];
        for (const s of staff) { const p = await payFor(s.id, month); delete p.rows; out.push({ ...s, ...p }); }
        res.json(out);
    }));
    app.post('/api/admin/payroll/pay', needAdmin, wrap(async (req, res) => {
        const month = String(req.body.month || ''), uid = Number(req.body.user_id);
        if (!/^\d{4}-\d{2}$/.test(month) || !uid) return res.status(400).json({ message: 'Bad request' });
        if (await get('SELECT 1 FROM payroll_paid WHERE user_id=? AND month=?', [uid, month])) return res.status(400).json({ message: 'Already marked as paid' });
        const p = await payFor(uid, month);
        await run('INSERT INTO payroll_paid (user_id,month,amount,paid_at) VALUES (?,?,?,?)', [uid, month, p.earned, nowStr()]);
        res.json({ success: true, amount: p.earned });
    }));
    app.get('/api/admin/riders', needAdmin, wrap(async (req, res) => {
        res.json(await all(`SELECT u.id,u.name,u.phone,l.lat,l.lng,l.updated_at,
            (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='Dispatched') active
            FROM users u JOIN attendance a ON a.user_id=u.id AND a.day=? AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
            LEFT JOIN rider_locations l ON l.user_id=u.id WHERE u.role='rider'`, [today()]));
    }));
};
