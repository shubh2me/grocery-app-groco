// Web Push (alerts that reach a phone even when the page is closed). Needs:  npm i web-push   and HTTPS (or localhost).
let wp = null; try { wp = require('web-push'); } catch (e) {}
module.exports = function (run, get, all) {
    let ready = false, pub = '';
    async function init() {
        if (!wp) return false;
        let p = (await get(`SELECT value FROM settings WHERE key='vapid_public'`)), s = (await get(`SELECT value FROM settings WHERE key='vapid_private'`));
        if (!p || !s) {
            const k = wp.generateVAPIDKeys();
            await run(`INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_public',?),('vapid_private',?)`, [k.publicKey, k.privateKey]);
            p = { value: k.publicKey }; s = { value: k.privateKey };
        }
        wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@groco.com', p.value, s.value);
        pub = p.value; ready = true; return true;
    }
    async function publicKey() { if (!ready) await init(); return pub; }
    async function subscribe(userId, sub) {
        await run('INSERT INTO push_subs (user_id,endpoint,data) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, data=excluded.data', [userId, sub.endpoint, JSON.stringify(sub)]);
    }
    // role: 'picker' | 'rider' (also reaches admins); only staff who are punched in today
    async function toRole(role, payload) {
        if (!ready && !(await init())) return 0;
        const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const subs = await all(`SELECT ps.* FROM push_subs ps JOIN users u ON u.id=ps.user_id JOIN attendance a ON a.user_id=u.id AND a.day=? AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
                                WHERE u.role=? AND u.active=1`, [day, role]);
        let n = 0;
        for (const s of subs) {
            try { await wp.sendNotification(JSON.parse(s.data), JSON.stringify(payload)); n++; }
            catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await run('DELETE FROM push_subs WHERE id=?', [s.id]); }
        }
        return n;
    }
    return { init, publicKey, subscribe, toRole, available: () => !!wp };
};
