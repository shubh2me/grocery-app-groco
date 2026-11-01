// Stock = batches (each with an expiry date). Selling uses First-Expiry-First-Out; expired batches are never sellable.
module.exports = function (run, get, all) {
    const pad = n => String(n).padStart(2, '0');
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s));

    const sellable = async bc => (await get(`SELECT COALESCE(SUM(qty),0) s FROM batches WHERE barcode=? AND qty>0 AND (expiry_date IS NULL OR expiry_date>=?)`, [bc, today()])).s;
    const onHand = async bc => (await get(`SELECT COALESCE(SUM(qty),0) s FROM batches WHERE barcode=? AND qty>0`, [bc])).s;
    async function recalc(bc) {
        const q = await sellable(bc);
        await run('UPDATE products SET quantity=?, inStock=? WHERE barcode=?', [q, q > 0 ? 1 : 0, bc]);
        return q;
    }
    async function log(type, bc, delta, reason, batchId, user) {
        const p = await get('SELECT title, variant FROM products WHERE barcode=?', [bc]);
        await run('INSERT INTO stock_log (barcode,title,type,qty_change,reason,batch_id,user_name) VALUES (?,?,?,?,?,?,?)',
            [bc, p ? `${p.title} (${p.variant})` : bc, type, delta, reason || '', batchId || null, user || 'system']);
    }
    async function addBatch(bc, qty, expiry, batchNo, user, type = 'receive', reason = '') {
        const no = batchNo || ('B' + Date.now().toString().slice(-6));
        const r = await run('INSERT INTO batches (barcode,batch_no,qty,received_qty,expiry_date,received_by) VALUES (?,?,?,?,?,?)',
            [bc, no, qty, qty, validDate(expiry) ? expiry : null, user || 'system']);
        await log(type, bc, qty, reason || `batch ${no}${expiry ? ' exp ' + expiry : ''}`, r.lastID, user);
        await recalc(bc);
        return r.lastID;
    }
    // take qty out, soonest-expiry first. includeExpired=true is used by counts (expired stock is still physically on the shelf)
    async function deduct(bc, qty, includeExpired = false) {
        const rows = await all(`SELECT * FROM batches WHERE barcode=? AND qty>0 ${includeExpired ? '' : 'AND (expiry_date IS NULL OR expiry_date>=?)'}
                                ORDER BY (expiry_date IS NULL), expiry_date ASC, id ASC`, includeExpired ? [bc] : [bc, today()]);
        let left = qty;
        for (const b of rows) {
            if (left <= 0) break;
            const take = Math.min(b.qty, left);
            await run('UPDATE batches SET qty=qty-? WHERE id=?', [take, b.id]);
            left -= take;
        }
        await recalc(bc);
        return qty - left;
    }
    async function restore(bc, qty) {                       // cancelled order: put units back on the freshest-expiring good batch
        const b = await get(`SELECT id FROM batches WHERE barcode=? AND (expiry_date IS NULL OR expiry_date>=?) ORDER BY (expiry_date IS NULL), expiry_date ASC LIMIT 1`, [bc, today()]);
        if (b) { await run('UPDATE batches SET qty=qty+? WHERE id=?', [qty, b.id]); await recalc(bc); }
        else await addBatch(bc, qty, null, 'RETURN', 'system', 'return', 'cancelled order');
    }
    async function setStock(bc, target, user, reason) {     // admin typed a new quantity
        const cur = await sellable(bc), diff = target - cur;
        if (diff > 0) await addBatch(bc, diff, null, 'ADJ', user, 'adjust', reason || 'manual adjustment');
        else if (diff < 0) { await deduct(bc, -diff); await log('adjust', bc, diff, reason || 'manual adjustment', null, user); }
        return recalc(bc);
    }
    async function refreshAll() {                           // run on a timer: expiry dates pass, so sellable stock can drop by itself
        let changed = 0;
        for (const p of await all(`SELECT p.barcode, p.quantity FROM products p WHERE EXISTS (SELECT 1 FROM batches b WHERE b.barcode=p.barcode)`)) {
            const q = await sellable(p.barcode);
            if (q !== p.quantity) { await run('UPDATE products SET quantity=?, inStock=? WHERE barcode=?', [q, q > 0 ? 1 : 0, p.barcode]); changed++; }
        }
        return changed;
    }
    return { today, validDate, sellable, onHand, recalc, log, addBatch, deduct, restore, setStock, refreshAll };
};
