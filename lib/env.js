// Tiny .env loader (no dependency): reads KEY=value lines from ./.env without overriding real environment variables.
const fs = require('fs'), path = require('path');
module.exports = function load() {
    const f = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
        if (!m || line.trim().startsWith('#')) continue;
        let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
};
