// Settings, online payments, password reset, invoices, ratings, issues & refunds, rider cash, purchasing, backups, push.
const crypto = require('crypto'), path = require('path');
module.exports = function (ctx) {
    const { app, run, get, all, wrap, needAdmin, needUser, needStaff, broadcast, catalogChanged, toAdmins, stock, bcrypt, jwt, JWT_SECRET, settings, bustSettings, makeSlots,
        notify, announceNewOrder, createRefund, cancelOrder, payments, push, backup, invoiceHtml, tooMany, failed } = ctx;
    const pad = n => String(n).padStart(2, '0');
    const todayStr = stock.today;
    const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
    const r2 = n => Math.round(n * 100) / 100;
    const sendTo = async (email, text, subject) => { const u = await get('SELECT phone,email FROM users WHERE email=?', [email]); return notify.send({ phone: u && u.phone, email }, text, subject); };

    // ---------- settings ----------
    app.get('/api/settings/public', wrap(async (req, res) => {
        const st = await settings(), sl = makeSlots(st);
        res.json({ min_order: Number(st.min_order), delivery_fee: Number(st.delivery_fee), free_delivery_above: Number(st.free_delivery_above), store_open: st.store_open, store_close: st.store_close, store_name: st.store_name,
            pincodes: String(st.serviceable_pincodes || '').split(/[,\s]+/).filter(Boolean), is_open: sl.isOpen, slots: st.slots_enabled === '0' ? [] : sl.slots,
            payment: payments.enabled() ? 'razorpay' : 'demo' });
    }));
    const HHMM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
    const SETTING_RULES = { min_order: v => v >= 0, delivery_fee: v => v >= 0, free_delivery_above: v => v >= 0, delivery_gst: v => v >= 0 && v <= 28 };
    app.get('/api/admin/settings', needAdmin, wrap(async (req, res) => {
        const st = { ...(await settings()) }; delete st.vapid_private; delete st.vapid_public;
        res.json({ settings: st, integrations: { payments: payments.enabled() ? 'Razorpay LIVE' : 'Demo mode (no keys)', messaging: notify.configured(), push: push.available(), https: !!(process.env.SSL_KEY && process.env.SSL_CERT) } });
    }));
    app.put('/api/admin/settings', needAdmin, wrap(async (req, res) => {
        const b = req.body || {}, out = {};
        for (const k of Object.keys(SETTING_RULES)) if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isFinite(v) || !SETTING_RULES[k](v)) return res.status(400).json({ message: `Invalid value for ${k}` }); out[k] = String(v); }
        for (const k of ['store_open', 'store_close']) if (b[k] !== undefined) { if (!HHMM(b[k])) return res.status(400).json({ message: 'Store hours must look like 08:00' }); out[k] = b[k]; }
        for (const k of ['store_name', 'store_address', 'store_gstin', 'store_phone']) if (b[k] !== undefined) out[k] = String(b[k]).slice(0, 200);
        if (b.serviceable_pincodes !== undefined) { const pins = String(b.serviceable_pincodes).split(/[,\s]+/).filter(Boolean); if (pins.some(p => !/^\d{6}$/.test(p))) return res.status(400).json({ message: 'Pincodes must be 6 digits, separated by commas' }); out.serviceable_pincodes = pins.join(','); }
        for (const k of ['slots_enabled', 'auto_reorder']) if (b[k] !== undefined) out[k] = b[k] === '0' || b[k] === 0 || b[k] === false ? '0' : '1';
        if (b.gst_rates !== undefined) { let g; try { g = typeof b.gst_rates === 'string' ? JSON.parse(b.gst_rates) : b.gst_rates; } catch (e) { return res.status(400).json({ message: 'GST rates must be valid JSON' }); }
            if (!g || typeof g !== 'object' || Object.values(g).some(v => !Number.isFinite(Number(v)) || v < 0 || v > 28)) return res.status(400).json({ message: 'Each GST rate must be a number from 0 to 28' }); out.gst_rates = JSON.stringify(g); }
        for (const [k, v] of Object.entries(out)) await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v]);
        bustSettings(); res.json({ success: true });
    }));
    app.get('/api/admin/outbox', needAdmin, wrap(async (req, res) => res.json(await all('SELECT * FROM outbox ORDER BY id DESC LIMIT 60'))));
    app.post('/api/admin/test-message', needAdmin, wrap(async (req, res) => {
        const sent = await notify.send({ phone: req.body.phone, email: req.body.email }, 'Groco test message: notifications are working.', 'Groco test');
        res.json({ channels: sent.length ? sent : ['console (nothing configured; see the outbox)'] });
    }));

    // ---------- online payment ----------
    app.post('/api/payments/verify', needUser, wrap(async (req, res) => {
        const o = await get('SELECT * FROM orders WHERE id=? AND customer_email=?', [req.body.order_id, req.user.email]);
        if (!o) return res.status(404).json({ message: 'Order not found' });
        if (o.payment_status === 'paid') return res.json({ success: true });
        if (o.status === 'Cancelled') return res.status(400).json({ message: 'This order expired before payment. Please order again.' });
        if (o.payment_status !== 'pending') return res.status(400).json({ message: 'Nothing to pay for this order' });
        let pid;
        if (payments.enabled()) {
            if (!payments.verify(o.rzp_order_id, req.body.razorpay_payment_id, req.body.razorpay_signature)) return res.status(400).json({ message: 'Payment could not be verified. If money was deducted it will be refunded automatically.' });
            pid = String(req.body.razorpay_payment_id);
        } else { if (req.body.demo !== true) return res.status(400).json({ message: 'Payment not completed' }); pid = 'demo_' + Date.now(); }
        await run(`UPDATE orders SET payment_status='paid', rzp_payment_id=?, updated_at=datetime('now','localtime') WHERE id=?`, [pid, o.id]);
        announceNewOrder(await get('SELECT * FROM orders WHERE id=?', [o.id]));
        res.json({ success: true });
    }));
    app.get('/api/orders/:id/payment', needUser, wrap(async (req, res) => {           // lets a customer finish paying from My Orders
        const o = await get(`SELECT * FROM orders WHERE id=? AND customer_email=? AND payment_status='pending' AND status='Placed'`, [req.params.id, req.user.email]);
        if (!o) return res.status(404).json({ message: 'Nothing to pay for this order' });
        if (!payments.enabled()) return res.json({ provider: 'demo', amount: Math.round(o.total_amount * 100) });
        res.json({ provider: 'razorpay', key: payments.keyId(), order_id: o.rzp_order_id, amount: Math.round(o.total_amount * 100), name: o.customer_name, email: o.customer_email, phone: o.customer_phone });
    }));
    setInterval(async () => {                                // unpaid online orders are released after 15 minutes
        try { for (const o of await all(`SELECT id FROM orders WHERE payment_status='pending' AND status='Placed' AND created_at < datetime('now','localtime','-15 minutes')`)) await cancelOrder(o.id, null, 'payment timeout'); } catch (e) {}
    }, 60 * 1000);

    // ---------- forgot / reset password (customers, staff, admin) ----------
    app.post('/api/auth/forgot', wrap(async (req, res) => {
        const email = String(req.body.email || '').trim().toLowerCase(), key = 'forgot|' + email;
        if (tooMany(key)) return res.status(429).json({ message: 'Too many requests. Please wait a few minutes.' });
        failed(key);
        const u = await get('SELECT * FROM users WHERE email=? AND active=1', [email]);
        if (u) {
            const code = String(crypto.randomInt(100000, 1000000));
            await run(`INSERT INTO password_resets (email,code_hash,expires_at) VALUES (?,?,datetime('now','localtime','+15 minutes'))`, [email, sha(code)]);
            notify.send(u, `Groco: your password reset code is ${code}. It expires in 15 minutes. If you did not ask for this, ignore this message.`, 'Password reset code').catch(() => {});
        }
        res.json({ message: 'If that email has an account, a 6-digit code has been sent to its phone / email.' });
    }));
    app.post('/api/auth/reset', wrap(async (req, res) => {
        const email = String(req.body.email || '').trim().toLowerCase(), code = String(req.body.code || '').trim(), pw = String(req.body.password || '');
        if (pw.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });
        const row = await get(`SELECT * FROM password_resets WHERE email=? AND used=0 AND expires_at > datetime('now','localtime') ORDER BY id DESC LIMIT 1`, [email]);
        if (!row) return res.status(400).json({ message: 'That code has expired. Request a new one.' });
        if (row.attempts >= 5) return res.status(400).json({ message: 'Too many wrong codes. Request a new one.' });
        if (sha(code) !== row.code_hash) { await run('UPDATE password_resets SET attempts=attempts+1 WHERE id=?', [row.id]); return res.status(400).json({ message: 'Wrong code' }); }
        await run('UPDATE users SET password=? WHERE email=?', [await bcrypt.hash(pw, 10), email]);
        await run('UPDATE password_resets SET used=1 WHERE email=?', [email]);
        res.json({ success: true });
    }));

    // ---------- invoice (HTML you can print / save as PDF) ----------
    app.get('/api/orders/:id/invoice', wrap(async (req, res) => {
        const h = req.headers['authorization'] || '', token = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.token || '');
        let user; try { user = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).send('Please sign in again'); }
        const o = await get('SELECT * FROM orders WHERE id=?', [req.params.id]);
        if (!o || (user.role !== 'admin' && o.customer_email !== user.email)) return res.status(404).send('Order not found');
        const st = await settings();
        res.set({ 'Content-Type': 'text/html; charset=utf-8' }).send(invoiceHtml(o, st, JSON.parse(st.gst_rates || '{}')));
    }));

    // ---------- rider rating ----------
    app.post('/api/orders/:id/rate', needUser, wrap(async (req, res) => {
        const o = await get(`SELECT * FROM orders WHERE id=? AND customer_email=? AND status='Delivered' AND rider_id IS NOT NULL`, [req.params.id, req.user.email]);
        if (!o) return res.status(404).json({ message: 'You can rate a delivered order' });
        const stars = parseInt(req.body.stars, 10);
        if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ message: 'Choose 1 to 5 stars' });
        if (await get('SELECT 1 FROM ratings WHERE order_id=?', [o.id])) return res.status(400).json({ message: 'You already rated this delivery' });
        await run('INSERT INTO ratings (order_id,rider_id,stars,comment) VALUES (?,?,?,?)', [o.id, o.rider_id, stars, String(req.body.comment || '').slice(0, 200)]);
        res.json({ success: true });
    }));

    // ---------- customer problems (missing / damaged / wrong item) ----------
    const REASONS = ['missing', 'damaged', 'wrong', 'quality', 'other'];
    app.post('/api/orders/:id/issue', needUser, wrap(async (req, res) => {
        const o = await get(`SELECT * FROM orders WHERE id=? AND customer_email=? AND status='Delivered'`, [req.params.id, req.user.email]);
        if (!o) return res.status(404).json({ message: 'You can report a problem on a delivered order' });
        if (o.delivered_at && Date.now() - new Date(o.delivered_at.replace(' ', 'T')).getTime() > 48 * 3600e3) return res.status(400).json({ message: 'Problems can be reported within 48 hours of delivery' });
        const it = JSON.parse(o.items || '[]').find(i => i.barcode === req.body.barcode); if (!it) return res.status(400).json({ message: 'Choose an item from this order' });
        const qty = Math.min(it.qty, Math.max(1, parseInt(req.body.qty, 10) || 1)), reason = REASONS.includes(req.body.reason) ? req.body.reason : 'other';
        if (await get(`SELECT 1 FROM issues WHERE order_id=? AND barcode=? AND status IN ('open','approved')`, [o.id, it.barcode])) return res.status(400).json({ message: 'You already reported this item' });
        await run('INSERT INTO issues (order_id,barcode,title,qty,reason,note) VALUES (?,?,?,?,?,?)', [o.id, it.barcode, `${it.title} (${it.variant})`, qty, reason, String(req.body.note || '').slice(0, 300)]);
        broadcast('issue:new', { order_id: o.id }, toAdmins);
        res.status(201).json({ success: true });
    }));
    app.get('/api/orders/:id/issues', needUser, wrap(async (req, res) => {
        res.json(await all(`SELECT i.* FROM issues i JOIN orders o ON o.id=i.order_id WHERE i.order_id=? AND o.customer_email=? ORDER BY i.id DESC`, [req.params.id, req.user.email]));
    }));
    app.get('/api/admin/issues', needAdmin, wrap(async (req, res) => res.json(await all(`SELECT i.*, o.customer_name, o.customer_phone, o.payment_mode, o.total_amount,
        (SELECT json_extract(j.value,'$.price') FROM json_each(o.items) j WHERE json_extract(j.value,'$.barcode')=i.barcode) unit_price FROM issues i JOIN orders o ON o.id=i.order_id ORDER BY (i.status='open') DESC, i.id DESC LIMIT 100`))));
    app.post('/api/admin/issues/:id/resolve', needAdmin, wrap(async (req, res) => {
        const i = await get('SELECT * FROM issues WHERE id=?', [req.params.id]); if (!i || i.status !== 'open') return res.status(400).json({ message: 'Already resolved' });
        const o = await get('SELECT * FROM orders WHERE id=?', [i.order_id]), action = req.body.action, note = String(req.body.note || '').slice(0, 200);
        if (action === 'approve') {
            const it = JSON.parse(o.items || '[]').find(x => x.barcode === i.barcode), max = o.total_amount - (o.refunded || 0);
            const amt = Math.min(max, r2(Number(req.body.amount) || (it ? it.price * i.qty : 0)));
            if (!(amt > 0)) return res.status(400).json({ message: 'Nothing left to refund on this order' });
            await createRefund(o.id, amt, `issue #${i.id}: ${i.reason}`);
            await run(`UPDATE issues SET status='approved', refund_amount=?, admin_note=?, resolved_by=?, resolved_at=datetime('now','localtime') WHERE id=?`, [amt, note, req.user.name, i.id]);
            sendTo(o.customer_email, `Groco: sorry about ${i.title}. We approved a refund of ₹${amt} for order ${o.id}.`, 'Refund approved').catch(() => {});
        } else if (action === 'reject') {
            await run(`UPDATE issues SET status='rejected', admin_note=?, resolved_by=?, resolved_at=datetime('now','localtime') WHERE id=?`, [note, req.user.name, i.id]);
            sendTo(o.customer_email, `Groco: we reviewed your report for order ${o.id} and could not approve a refund. ${note}`, 'Report update').catch(() => {});
        } else return res.status(400).json({ message: 'Choose approve or reject' });
        res.json({ success: true });
    }));
    app.get('/api/admin/refunds', needAdmin, wrap(async (req, res) => res.json(await all(`SELECT r.*, o.customer_name, o.customer_phone, o.payment_mode, o.rzp_payment_id FROM refunds r JOIN orders o ON o.id=r.order_id ORDER BY (r.status='pending') DESC, r.id DESC LIMIT 150`))));
    app.post('/api/admin/refunds/:id/process', needAdmin, wrap(async (req, res) => {
        const r = await get('SELECT * FROM refunds WHERE id=?', [req.params.id]); if (!r || r.status !== 'pending') return res.status(400).json({ message: 'Already processed' });
        const o = await get('SELECT * FROM orders WHERE id=?', [r.order_id]);
        if (req.body.gateway && payments.enabled() && o.rzp_payment_id && !String(o.rzp_payment_id).startsWith('demo')) { try { await payments.refund(o.rzp_payment_id, r.amount); } catch (e) { return res.status(502).json({ message: e.message }); } }
        await run(`UPDATE refunds SET status='processed', processed_at=datetime('now','localtime'), processed_by=?, note=COALESCE(?, note) WHERE id=?`, [req.user.name, String(req.body.note || '').slice(0, 200) || null, r.id]);
        sendTo(o.customer_email, `Groco: your refund of ₹${r.amount} for order ${o.id} has been processed.`, 'Refund processed').catch(() => {});
        res.json({ success: true });
    }));

    // ---------- rider cash settlement ----------
    app.get('/api/admin/cash', needAdmin, wrap(async (req, res) => {
        const riders = await all(`SELECT u.id,u.name,COALESCE(SUM(o.cash_collected),0) owed, COUNT(o.id) orders FROM users u LEFT JOIN orders o ON o.rider_id=u.id AND o.status='Delivered' AND o.payment_mode='COD' AND o.settlement_id IS NULL
            WHERE u.role='rider' GROUP BY u.id ORDER BY owed DESC`);
        res.json({ riders, history: await all('SELECT c.*, u.name FROM cash_settlements c JOIN users u ON u.id=c.rider_id ORDER BY c.id DESC LIMIT 40') });
    }));
    app.post('/api/admin/cash/settle', needAdmin, wrap(async (req, res) => {
        const rid = Number(req.body.rider_id), pend = await all(`SELECT id,cash_collected FROM orders WHERE rider_id=? AND status='Delivered' AND payment_mode='COD' AND settlement_id IS NULL`, [rid]);
        if (!pend.length) return res.status(400).json({ message: 'This rider has no unsettled cash' });
        const owed = r2(pend.reduce((n, o) => n + o.cash_collected, 0)), got = req.body.amount === undefined || req.body.amount === '' ? owed : r2(Number(req.body.amount));
        if (!(got >= 0)) return res.status(400).json({ message: 'Enter the cash amount received' });
        const diff = r2(got - owed), note = (diff === 0 ? 'exact' : diff < 0 ? `SHORT by ₹${-diff}` : `EXCESS ₹${diff}`) + (req.body.note ? ' · ' + String(req.body.note).slice(0, 100) : '');
        const s = await run('INSERT INTO cash_settlements (rider_id,amount,received_by,note) VALUES (?,?,?,?)', [rid, got, req.user.name, note]);
        for (const o of pend) await run('UPDATE orders SET settlement_id=? WHERE id=?', [s.lastID, o.id]);
        res.json({ success: true, owed, received: got, diff });
    }));

    // ---------- purchasing: suppliers, reorder suggestions, purchase orders ----------
    app.get('/api/admin/suppliers', needAdmin, wrap(async (req, res) => res.json(await all('SELECT * FROM suppliers ORDER BY name'))));
    app.post('/api/admin/suppliers', needAdmin, wrap(async (req, res) => {
        const n = String(req.body.name || '').trim(); if (n.length < 2) return res.status(400).json({ message: 'Enter the supplier name' });
        const r = await run('INSERT INTO suppliers (name,phone,email,notes) VALUES (?,?,?,?)', [n, String(req.body.phone || '').slice(0, 20), String(req.body.email || '').slice(0, 80), String(req.body.notes || '').slice(0, 200)]);
        res.status(201).json({ id: r.lastID });
    }));
    app.delete('/api/admin/suppliers/:id', needAdmin, wrap(async (req, res) => { await run('UPDATE products SET supplier_id=NULL WHERE supplier_id=?', [req.params.id]); await run('DELETE FROM suppliers WHERE id=?', [req.params.id]); res.json({ success: true }); }));
    app.patch('/api/admin/products/:barcode/reorder', needAdmin, wrap(async (req, res) => {
        const b = req.body, lv = Math.max(0, parseInt(b.reorder_level, 10) || 0), q = Math.max(1, parseInt(b.reorder_qty, 10) || 1), cost = b.cost_price === '' || b.cost_price == null ? null : Math.max(0, Number(b.cost_price));
        await run('UPDATE products SET reorder_level=?, reorder_qty=?, supplier_id=?, cost_price=? WHERE barcode=?', [lv, q, b.supplier_id ? Number(b.supplier_id) : null, cost, req.params.barcode]); res.json({ success: true });
    }));
    const SUGG = `SELECT p.barcode,p.title,p.variant,p.quantity,p.reorder_level,p.reorder_qty,p.supplier_id,p.cost_price,s.name supplier_name,
        (SELECT COALESCE(SUM(i.qty - i.qty_received),0) FROM po_items i JOIN purchase_orders o ON o.id=i.po_id WHERE i.barcode=p.barcode AND o.status IN ('draft','sent')) on_order
        FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.quantity <= p.reorder_level ORDER BY p.quantity ASC, p.title LIMIT 400`;
    app.get('/api/admin/reorder-suggestions', needAdmin, wrap(async (req, res) => res.json(await all(SUGG))));
    async function createPO(supplierId, items, note, status, user) {
        const r = await run('INSERT INTO purchase_orders (supplier_id,status,note,created_by) VALUES (?,?,?,?)', [supplierId || null, status, note || '', user]);
        for (const it of items) { const p = await get('SELECT title,variant FROM products WHERE barcode=?', [it.barcode]); if (!p) continue;
            await run('INSERT INTO po_items (po_id,barcode,title,qty,cost) VALUES (?,?,?,?,?)', [r.lastID, it.barcode, `${p.title} (${p.variant})`, Math.max(1, parseInt(it.qty, 10) || 1), Math.max(0, Number(it.cost) || 0)]); }
        return r.lastID;
    }
    async function autoDrafts(user) {                                 // one draft PO per supplier for everything that is low and not already on order
        const rows = (await all(SUGG)).filter(r => r.supplier_id && r.on_order <= 0), by = {};
        rows.forEach(r => (by[r.supplier_id] = by[r.supplier_id] || []).push({ barcode: r.barcode, qty: r.reorder_qty, cost: r.cost_price || 0 }));
        let n = 0; for (const [sid, items] of Object.entries(by)) { await createPO(Number(sid), items, 'Auto-generated from low stock', 'draft', user); n++; }
        return n;
    }
    app.post('/api/admin/purchase-orders', needAdmin, wrap(async (req, res) => {
        const items = Array.isArray(req.body.items) ? req.body.items.filter(i => i.barcode) : [];
        if (!items.length) return res.status(400).json({ message: 'Add at least one item' });
        res.status(201).json({ id: await createPO(req.body.supplier_id, items, req.body.note, req.body.status === 'draft' ? 'draft' : 'sent', req.user.name) });
    }));
    app.post('/api/admin/purchase-orders/auto', needAdmin, wrap(async (req, res) => res.json({ drafts: await autoDrafts(req.user.name) })));
    app.get('/api/admin/purchase-orders', needAdmin, wrap(async (req, res) => {
        const pos = await all(`SELECT o.*, s.name supplier_name, s.phone supplier_phone FROM purchase_orders o LEFT JOIN suppliers s ON s.id=o.supplier_id ORDER BY o.id DESC LIMIT 60`);
        for (const o of pos) o.items = await all('SELECT * FROM po_items WHERE po_id=?', [o.id]);
        res.json(pos);
    }));
    app.post('/api/admin/purchase-orders/:id/send', needAdmin, wrap(async (req, res) => { await run(`UPDATE purchase_orders SET status='sent' WHERE id=? AND status='draft'`, [req.params.id]); res.json({ success: true }); }));
    app.post('/api/admin/purchase-orders/:id/cancel', needAdmin, wrap(async (req, res) => { await run(`UPDATE purchase_orders SET status='cancelled' WHERE id=? AND status IN ('draft','sent')`, [req.params.id]); res.json({ success: true }); }));
    app.post('/api/admin/purchase-orders/:id/receive', needAdmin, wrap(async (req, res) => {
        const po = await get(`SELECT * FROM purchase_orders WHERE id=? AND status='sent'`, [req.params.id]); if (!po) return res.status(400).json({ message: 'Only sent orders can be received' });
        for (const l of Array.isArray(req.body.items) ? req.body.items : []) {
            const it = await get('SELECT * FROM po_items WHERE id=? AND po_id=?', [l.id, po.id]); if (!it) continue;
            const qty = Math.max(0, Math.min(it.qty - it.qty_received, parseInt(l.qty_received, 10) || 0)); if (!qty) continue;
            const exp = String(l.expiry_date || '').trim();
            if (exp && (!stock.validDate(exp) || exp < todayStr())) return res.status(400).json({ message: `Check the expiry date for ${it.title}` });
            await stock.addBatch(it.barcode, qty, exp, 'PO' + po.id, req.user.name, 'receive', `purchase order #${po.id}`);
            await run('UPDATE po_items SET qty_received=qty_received+?, expiry_date=? WHERE id=?', [qty, exp || null, it.id]);
            if (it.cost > 0) await run('UPDATE products SET cost_price=? WHERE barcode=?', [it.cost, it.barcode]);
        }
        const open = await get('SELECT COUNT(*) n FROM po_items WHERE po_id=? AND qty_received < qty', [po.id]);
        if (!open.n || req.body.close) await run(`UPDATE purchase_orders SET status='received', received_at=datetime('now','localtime') WHERE id=?`, [po.id]);
        catalogChanged('stock'); res.json({ success: true });
    }));

    // ---------- backups ----------
    app.get('/api/admin/backups', needAdmin, (req, res) => res.json(backup.list()));
    app.post('/api/admin/backup/now', needAdmin, wrap(async (req, res) => res.json({ name: await backup.now('manual') })));
    app.get('/api/admin/backup/download', wrap(async (req, res) => {
        let user; try { user = jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch (e) { return res.status(401).send('Sign in again'); }
        if (user.role !== 'admin') return res.status(403).send('Admin only');
        const f = backup.filePath(req.query.name); if (!f) return res.status(404).send('Not found');
        res.download(f);
    }));
    const dailyBackup = async () => { try { if (!backup.list().some(b => b.name.includes(todayStr()))) await backup.now('auto'); } catch (e) { console.error('backup failed', e.message); } };
    setTimeout(dailyBackup, 15 * 1000); setInterval(dailyBackup, 60 * 60 * 1000);
    setInterval(async () => { try { if ((await settings()).auto_reorder === '1' && new Date().getHours() === 7) await autoDrafts('auto'); } catch (e) {} }, 60 * 60 * 1000);

    // ---------- push notifications ----------
    app.get('/api/push/key', wrap(async (req, res) => res.json({ available: push.available(), key: push.available() ? await push.publicKey() : null })));
    app.post('/api/staff/push-subscribe', needStaff, wrap(async (req, res) => {
        const s = req.body.subscription; if (!s || !s.endpoint) return res.status(400).json({ message: 'Bad subscription' });
        await push.subscribe(req.user.id, s); res.json({ success: true });
    }));
    app.get('/sw.js', (req, res) => res.set({ 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' }).sendFile(path.join(__dirname, 'sw.js')));
};
