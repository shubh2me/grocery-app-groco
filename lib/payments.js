// Razorpay without the SDK. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to go live.
// With no keys the store runs in DEMO payment mode (nobody is charged; the customer just presses "Pay").
const crypto = require('crypto');
const KEY = process.env.RAZORPAY_KEY_ID, SECRET = process.env.RAZORPAY_KEY_SECRET;
const enabled = () => !!(KEY && SECRET);
const auth = () => 'Basic ' + Buffer.from(KEY + ':' + SECRET).toString('base64');
async function createOrder(amountRupees, receipt) {
    const r = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(amountRupees * 100), currency: 'INR', receipt }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.description) || 'Razorpay error ' + r.status);
    return d;                                            // { id: 'order_xxx', ... }
}
function verify(rzpOrderId, paymentId, signature) {
    if (!enabled() || !rzpOrderId || !paymentId || !signature) return false;
    const expected = crypto.createHmac('sha256', SECRET).update(rzpOrderId + '|' + paymentId).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function refund(paymentId, amountRupees) {
    const r = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(amountRupees * 100) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.description) || 'Refund failed ' + r.status);
    return d;
}
module.exports = { enabled, keyId: () => KEY, createOrder, verify, refund };
