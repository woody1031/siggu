// Local dev server: serves prototype/ and runs api/*.js like Vercel does,
// backed by an in-memory stand-in for Upstash Redis (data is lost when it stops).
//
//   node scripts/dev-server.mjs            -> http://localhost:5174
//   node scripts/dev-server.mjs 5180       -> another port
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 5174);

// ---- in-memory Upstash REST (/pipeline) ----
const store = new Map();
const hash = k => { if (!store.has(k)) store.set(k, new Map()); return store.get(k); };
function run([cmd, ...a]) {
  switch (cmd.toUpperCase()) {
    case 'HGETALL': { const h = store.get(a[0]); return h ? [...h].flat() : []; }
    case 'HSET': { const h = hash(a[0]); for (let i = 1; i < a.length; i += 2) h.set(a[i], a[i + 1]); return 1; }
    case 'HGET': { const h = store.get(a[0]); return h && h.has(a[1]) ? h.get(a[1]) : null; }
    case 'HDEL': { const h = store.get(a[0]); let n = 0; for (const f of a.slice(1)) if (h && h.delete(f)) n++; return n; }
    case 'GET': { const v = store.get(a[0]); return typeof v === 'string' ? v : null; }
    case 'SET': store.set(a[0], a[1]); return 'OK';
    case 'DEL': return store.delete(a[0]) ? 1 : 0;
    default: throw new Error('unsupported ' + cmd);
  }
}
const redis = http.createServer((req, res) => {
  let body = ''; req.on('data', c => (body += c)); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer dev') { res.writeHead(401); return res.end(); }
    const out = JSON.parse(body).map(c => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
});
await new Promise(r => redis.listen(PORT + 1, '127.0.0.1', r));
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT + 1}`;
process.env.KV_REST_API_TOKEN = 'dev';

// ---- Vercel-like function runner + static files ----
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const file = path.join(ROOT, 'api', u.pathname.slice(5) + '.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    req.query = Object.fromEntries(u.searchParams);
    try { req.body = body ? JSON.parse(body) : undefined; } catch { req.body = body; }
    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = d => res.end(d);
    const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
    return mod.default(req, res);
  }
  const p = path.join(ROOT, 'prototype', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
  if (!p.startsWith(path.join(ROOT, 'prototype')) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Siggu dev server: http://localhost:${PORT}`));
