// Daily consistent copy of groco.db into ./backups (keeps the newest 14).
const fs = require('fs'), path = require('path');
module.exports = function (run, root) {
    const dir = path.join(root, 'backups');
    const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
    async function now(tag = 'auto') {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `groco-${stamp()}-${tag}.db`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        await run('VACUUM INTO ?', [file]);
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
        while (files.length > 14) fs.unlinkSync(path.join(dir, files.shift()));
        return path.basename(file);
    }
    const list = () => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort().reverse().map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtime.toISOString() })); } catch (e) { return []; } };
    const filePath = name => { const f = path.basename(String(name)); const p = path.join(dir, f); return f.endsWith('.db') && fs.existsSync(p) ? p : null; };
    return { now, list, filePath };
};
