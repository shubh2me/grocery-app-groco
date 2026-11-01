// Tax-invoice HTML. Prices in the store are GST-inclusive, so tax is carved out of the price.
// The GST % per category lives in Admin > Settings (starter values only: check them with your accountant).
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round(n * 100) / 100;
function invoiceHtml(order, settings, rates) {
    const items = JSON.parse(order.items || '[]'), lines = [];
    for (const it of items) {
        const rate = it.gst != null ? Number(it.gst) : (rates[it.category] ?? 0), gross = it.price * it.qty, taxable = gross / (1 + rate / 100);
        lines.push({ name: `${it.title} (${it.variant})`, qty: it.qty, rate, gross, taxable: r2(taxable), tax: r2(gross - taxable) });
    }
    if (order.delivery_fee > 0) { const rate = Number(settings.delivery_gst || 18), t = order.delivery_fee / (1 + rate / 100); lines.push({ name: 'Delivery charges', qty: 1, rate, gross: order.delivery_fee, taxable: r2(t), tax: r2(order.delivery_fee - t) }); }
    const byRate = {}; lines.forEach(l => { byRate[l.rate] = byRate[l.rate] || { taxable: 0, tax: 0 }; byRate[l.rate].taxable += l.taxable; byRate[l.rate].tax += l.tax; });
    const money = n => '₹' + r2(n).toFixed(2);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${esc(order.id)}</title>
<style>body{font-family:Arial,sans-serif;max-width:780px;margin:20px auto;color:#111;font-size:14px}table{width:100%;border-collapse:collapse;margin:14px 0}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f4f6}.r{text-align:right}
h1{margin:0;font-size:22px}.muted{color:#555}.box{display:flex;justify-content:space-between;gap:20px;margin-top:10px}@media print{button{display:none}}</style></head><body>
<button onclick="window.print()" style="float:right;padding:8px 14px">Print / Save as PDF</button>
<h1>${esc(settings.store_name || 'Groco')}</h1><div class="muted">${esc(settings.store_address || '')}${settings.store_phone ? ' · ' + esc(settings.store_phone) : ''}<br>${settings.store_gstin ? 'GSTIN: ' + esc(settings.store_gstin) : '<i>GSTIN not set (add it in Admin &gt; Settings)</i>'}</div>
<h2>Tax Invoice</h2>
<div class="box"><div><b>Invoice no:</b> INV-${esc(order.id)}<br><b>Date:</b> ${esc(order.created_at)}<br><b>Payment:</b> ${esc(order.payment_mode)} (${esc(order.payment_status)})</div>
<div><b>Billed to:</b> ${esc(order.customer_name)}<br>${esc(order.customer_phone || '')}<br>${esc(order.address)}</div></div>
<table><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">GST %</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">Amount</th></tr>
${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td class="r">${l.qty}</td><td class="r">${l.rate}%</td><td class="r">${money(l.taxable)}</td><td class="r">${money(l.tax)}</td><td class="r">${money(l.gross)}</td></tr>`).join('')}</table>
<table style="width:60%;margin-left:auto"><tr><th>GST %</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th></tr>
${Object.entries(byRate).map(([rt, v]) => `<tr><td>${rt}%</td><td class="r">${money(v.taxable)}</td><td class="r">${money(v.tax / 2)}</td><td class="r">${money(v.tax / 2)}</td></tr>`).join('')}</table>
<table style="width:60%;margin-left:auto">${order.discount ? `<tr><td>Coupon discount</td><td class="r">-${money(order.discount)}</td></tr>` : ''}<tr><td><b>Total paid / payable</b></td><td class="r"><b>${money(order.total_amount)}</b></td></tr></table>
<p class="muted">Prices include GST. This is a computer-generated invoice.</p></body></html>`;
}
module.exports = { invoiceHtml };
