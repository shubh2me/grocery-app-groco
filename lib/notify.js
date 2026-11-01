// Sends messages to customers/staff. Works with whatever you configure; with nothing configured it only
// records the message in the "outbox" table and prints it in the server terminal (handy while testing).
//   SMS / WhatsApp via Twilio : TWILIO_SID, TWILIO_TOKEN, TWILIO_SMS_FROM (+1..), TWILIO_WA_FROM (whatsapp:+1..)
//   Any other provider        : WEBHOOK_URL (we POST {to, channel, subject, text} as JSON; connect MSG91 / Fast2SMS / Meta WhatsApp via Zapier, n8n, etc.)
//   Email                     : SMTP_URL (e.g. smtps://user:pass@smtp.gmail.com) and MAIL_FROM  (needs: npm i nodemailer)
let nodemailer = null; try { nodemailer = require('nodemailer'); } catch (e) {}
module.exports = function (run, get, all) {
    const env = process.env;
    const phoneFmt = p => { const d = String(p || '').replace(/[^\d+]/g, ''); if (!d) return ''; if (d.startsWith('+')) return d; return d.length === 10 ? '+91' + d : '+' + d; };
    const configured = () => ({ sms: !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_SMS_FROM), whatsapp: !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_WA_FROM),
        webhook: !!env.WEBHOOK_URL, email: !!(nodemailer && env.SMTP_URL && env.MAIL_FROM) });
    async function twilio(to, from, body) {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, { method: 'POST',
            headers: { Authorization: 'Basic ' + Buffer.from(env.TWILIO_SID + ':' + env.TWILIO_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ To: to, From: from, Body: body }) });
        if (!r.ok) throw new Error('Twilio ' + r.status);
    }
    async function record(to, channel, subject, body, status) { try { await run('INSERT INTO outbox (to_addr,channel,subject,body,status) VALUES (?,?,?,?,?)', [to, channel, subject || '', body, status]); } catch (e) {} }
    // best effort, never throws
    async function send(user, text, subject) {
        const c = configured(), phone = phoneFmt(user && user.phone), mail = user && user.email, sent = [];
        const attempt = async (channel, to, fn) => { try { await fn(); sent.push(channel); await record(to, channel, subject, text, 'sent'); } catch (e) { await record(to, channel, subject, text, 'failed: ' + e.message); } };
        if (phone && c.sms) await attempt('sms', phone, () => twilio(phone, env.TWILIO_SMS_FROM, text));
        if (phone && c.whatsapp) await attempt('whatsapp', phone, () => twilio('whatsapp:' + phone, env.TWILIO_WA_FROM, text));
        if (c.webhook) await attempt('webhook', phone || mail, async () => { const r = await fetch(env.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: phone, email: mail, subject, text }) }); if (!r.ok) throw new Error('webhook ' + r.status); });
        if (mail && c.email) await attempt('email', mail, () => nodemailer.createTransport(env.SMTP_URL).sendMail({ from: env.MAIL_FROM, to: mail, subject: subject || 'Groco', text }));
        if (!sent.length) { await record(phone || mail || '?', 'console', subject, text, 'logged'); if (!env.QUIET) console.log(`📨 [message to ${phone || mail || 'unknown'}] ${text}`); }
        return sent;
    }
    return { send, configured, phoneFmt };
};
