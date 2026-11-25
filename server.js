#!/usr/bin/env node
/*
 * VAUNAFLIX — servidor local (sem dependências, Node 18+).
 *
 *   node server.js
 *
 * Abra o endereço mostrado no navegador do celular e da TV LG (mesmo Wi-Fi).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const { Library } = require('./lib/library');
const { Auth } = require('./lib/auth');
const { Sources } = require('./lib/sources');
const { handleProxy, probe } = require('./lib/proxy');

const ROOT = __dirname;

// carrega iptv/.env (IPTV_USER, IPTV_PASS, PORT, ...) sem sobrescrever o ambiente
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(function (l) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
} catch (e) { /* sem .env */ }

const PUB = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT) || 8787;
fs.mkdirSync(DATA, { recursive: true });

// ---------- estado persistente (favoritos, recentes, fontes) ----------
const STATE_FILE = path.join(DATA, 'state.json');
const state = Object.assign({ fav: [], recent: [], bad: {}, custom: [], enabled: {}, profiles: [] }, readJson(STATE_FILE) || {});
const AVATAR_COLORS = ['#e50914', '#0a84ff', '#f5a623', '#30d158', '#bf5af2', '#ff6482'];
// perfis (cada um com seus favoritos e "continuar assistindo"); migra o estado antigo
if (!state.profiles.length) {
  state.profiles = [{ id: 'p1', name: 'Principal', color: AVATAR_COLORS[0], fav: state.fav || [], recent: state.recent || [] }];
}
delete state.fav; delete state.recent;
function profileOf(req, q) {
  const id = req.headers['x-profile'] || (q && q.get('profile')) || '';
  return state.profiles.find(function (p) { return p.id === id; }) || state.profiles[0];
}
let saveTimer = null;
state.save = function () {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    const copy = Object.assign({}, state);
    delete copy.save;
    fs.writeFile(STATE_FILE, JSON.stringify(copy), function () {});
  }, 400);
};

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

const auth = new Auth(DATA);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ---------- biblioteca e fontes ----------
const library = new Library();
let rebuilding = false;
let rebuildAgain = false;

async function rebuild() {
  if (rebuilding) { rebuildAgain = true; return; }
  rebuilding = true;
  try {
    do {
      rebuildAgain = false;
      await library.rebuild(sources.active());
    } while (rebuildAgain);
  } finally { rebuilding = false; }
  broadcast('library', { totals: library.totals() });
}

const sources = new Sources(DATA, readJson(path.join(ROOT, 'sources.default.json')) || [], state, rebuild);

// ---------- aparelhos (TV receptora + controle remoto pelo celular) ----------
const clients = new Map(); // id -> { id, name, role, res, state, seen }

function deviceList() {
  return Array.from(clients.values()).filter(function (c) { return c.role === 'receiver'; })
    .map(function (c) { return { id: c.id, name: c.name, state: c.state || null }; });
}

function send(c, event, data) {
  try { c.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* conexão caiu */ }
}

function broadcast(event, data) { clients.forEach(function (c) { send(c, event, data); }); }
setInterval(function () { clients.forEach(function (c) { try { c.res.write(': ping\n\n'); } catch (e) { /* ok */ } }); }, 20000);

// ---------- utilidades HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    h['Content-Encoding'] = 'gzip';
    res.writeHead(code, h);
    return res.end(zlib.gzipSync(body));
  }
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req, max) {
  return new Promise(function (resolve, reject) {
    const bufs = [];
    let n = 0;
    req.on('data', function (b) { n += b.length; if (n > max) { reject(new Error('corpo grande demais')); req.destroy(); } else bufs.push(b); });
    req.on('end', function () {
      try { resolve(bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function lanUrls() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (k) {
    (nets[k] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) out.push('http://' + n.address + ':' + PORT);
    });
  });
  return out;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (file.indexOf(PUB) !== 0) { res.writeHead(403); return res.end(); }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('não encontrado'); }
    const ext = path.extname(file).toLowerCase();
    const vendor = rel.indexOf('/vendor/') === 0;
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': vendor ? 'public, max-age=604800' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const csv = function (s) { return s ? String(s).split(',').filter(Boolean) : null; };

// ---------- rotas ----------
let mm0;
async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;
  const m = req.method;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // ----- login -----
  const ip = (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const secure = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';

  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req, 2048);
    const r = auth.login(ip, b.user, b.pass);
    if (!r.ok) {
      await new Promise(function (ok) { setTimeout(ok, 500); });
      return json(req, res, r.locked ? 429 : 401, { error: r.locked ? 'Muitas tentativas. Tente de novo em 15 minutos.' : 'Usuário ou senha incorretos.' });
    }
    res.setHeader('Set-Cookie', auth.cookie(r.token, secure));
    return json(req, res, 200, { ok: true });
  }
  if (p === '/api/logout' && m === 'POST') {
    auth.logout(req);
    res.setHeader('Set-Cookie', auth.clearCookie());
    return json(req, res, 200, { ok: true });
  }
  if (p === '/api/me') return json(req, res, 200, { authed: auth.check(req), auth: auth.enabled, user: auth.user });

  const open = p === '/login.html' || p === '/manifest.webmanifest' || p.indexOf('/icons/') === 0 || p === '/css/login.css';
  if (!open && !auth.check(req)) {
    if (p.indexOf('/api/') === 0) return json(req, res, 401, { error: 'login necessário' });
    res.writeHead(302, { Location: '/login.html?next=' + encodeURIComponent(req.url) });
    return res.end();
  }

  if (p === '/api/profiles' && m === 'GET') {
    return json(req, res, 200, { profiles: state.profiles.map(function (x) { return { id: x.id, name: x.name, color: x.color }; }), colors: AVATAR_COLORS });
  }
  if (p === '/api/profiles' && m === 'POST') {
    const b = await readBody(req, 2048);
    const name = String(b.name || '').trim().slice(0, 20);
    if (!name) return json(req, res, 400, { error: 'Digite um nome.' });
    if (state.profiles.length >= 6) return json(req, res, 400, { error: 'Máximo de 6 perfis.' });
    const np = { id: 'p' + Date.now().toString(36), name: name, color: AVATAR_COLORS.indexOf(b.color) >= 0 ? b.color : AVATAR_COLORS[state.profiles.length % AVATAR_COLORS.length], fav: [], recent: [] };
    state.profiles.push(np); state.save();
    return json(req, res, 200, { id: np.id });
  }
  mm0 = p.match(/^\/api\/profiles\/([\w-]+)$/);
  if (mm0 && m === 'PATCH') {
    const b = await readBody(req, 2048);
    const t = state.profiles.find(function (x) { return x.id === mm0[1]; });
    if (!t) return json(req, res, 404, { error: 'perfil não encontrado' });
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 20); if (n) t.name = n; }
    if (AVATAR_COLORS.indexOf(b.color) >= 0) t.color = b.color;
    state.save();
    return json(req, res, 200, { ok: true });
  }
  if (mm0 && m === 'DELETE') {
    if (state.profiles.length <= 1) return json(req, res, 400, { error: 'Mantenha pelo menos um perfil.' });
    state.profiles = state.profiles.filter(function (x) { return x.id !== mm0[1]; }); state.save();
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/home' && m === 'GET') return json(req, res, 200, library.home(profileOf(req, q).fav, profileOf(req, q).recent));

  if (p === '/api/proxy') return handleProxy(req, res, q);

  if (p === '/api/probe' && m === 'GET') {
    try { return json(req, res, 200, await probe(q.get('u'), { referer: q.get('r') || '', ua: q.get('ua') || '' })); }
    catch (e) { return json(req, res, 200, { ok: false, status: 0, type: 'error', error: e.message }); }
  }

  if (p === '/api/info' && m === 'GET') {
    const counts = library.sourceCounts;
    return json(req, res, 200, {
      totals: library.totals(), builtAt: library.builtAt, building: rebuilding, urls: lanUrls(), port: PORT, user: auth.user,
      sources: sources.list().map(function (s) { const c = counts.get(s.id); return Object.assign(s, { counts: c || null }); }),
    });
  }

  if (p === '/api/groups' && m === 'GET') {
    return json(req, res, 200, library.groups[q.get('k') || 'l'] || []);
  }

  if (p === '/api/items' && m === 'GET') {
    const prof = profileOf(req, q);
    const ids = q.get('fav') ? prof.fav.slice().reverse() : q.get('recent') ? prof.recent : null;
    const hide = q.get('hide') ? new Set(Object.keys(state.bad)) : null;
    return json(req, res, 200, library.query({
      k: q.get('k') || 'l', g: q.get('g') || '', src: q.get('src') || '', q: q.get('q') || '',
      off: parseInt(q.get('off'), 10) || 0, lim: parseInt(q.get('lim'), 10) || 60, ids: ids, hide: hide,
    }));
  }

  let mm = p.match(/^\/api\/series\/([\w-]+)$/);
  if (mm && m === 'GET') {
    const d = library.seriesDetail(mm[1]);
    return d ? json(req, res, 200, d) : json(req, res, 404, { error: 'série não encontrada' });
  }

  mm = p.match(/^\/api\/stream\/([\w-]+)$/);
  if (mm && m === 'GET') {
    const s = library.streams(mm[1], q.get('ep') || '');
    if (!s) return json(req, res, 404, { error: 'item não encontrado' });
    s.next = s.k === 's' ? library.neighbor(s.id, s.ep, 1) : null;
    s.prev = s.k === 's' ? library.neighbor(s.id, s.ep, -1) : null;
    return json(req, res, 200, s);
  }

  if (p === '/api/state' && m === 'GET') {
    const pr = profileOf(req, q);
    return json(req, res, 200, { fav: pr.fav, recent: pr.recent, bad: state.bad });
  }

  if (p === '/api/fav' && m === 'POST') {
    const b = await readBody(req, 4096);
    const id = String(b.id || '');
    const pf = profileOf(req, q);
    const i = pf.fav.indexOf(id);
    if (b.on && i < 0) pf.fav.push(id);
    if (!b.on && i >= 0) pf.fav.splice(i, 1);
    state.save();
    clients.forEach(function (c) { if (c.profile === pf.id) send(c, 'state', { fav: pf.fav }); });
    return json(req, res, 200, { fav: pf.fav });
  }

  if (p === '/api/recent' && m === 'POST') {
    const b = await readBody(req, 4096);
    const id = String(b.id || '');
    const pr2 = profileOf(req, q);
    pr2.recent = [id].concat(pr2.recent.filter(function (x) { return x !== id; })).slice(0, 60);
    state.save();
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/bad' && m === 'POST') {
    const b = await readBody(req, 4096);
    const id = String(b.id || '');
    if (b.on) state.bad[id] = Date.now(); else delete state.bad[id];
    state.save();
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/sources' && m === 'POST') {
    const b = await readBody(req, 20 * 1024 * 1024);
    const name = String(b.name || '').trim().slice(0, 80) || 'Minha lista';
    let def;
    if (b.type === 'paste' && b.text) def = { name: name, type: 'paste', text: String(b.text) };
    else if (b.type === 'repo' && /^[\w.-]+\/[\w.-]+$/.test(b.repo || '')) def = { name: name, type: 'repo', repo: b.repo, files: [], discover: true };
    else if (b.type === 'user' && /^[\w.-]+$/.test(b.user || '')) def = { name: name, type: 'user', user: b.user };
    else if (b.type === 'web' && /^https?:\/\//i.test(b.url || '')) def = { name: name, type: 'web', url: b.url };
    else if (b.type === 'urls' && /^https?:\/\//i.test(b.url || '')) def = { name: name, type: 'urls', urls: [b.url] };
    else return json(req, res, 400, { error: 'dados da fonte inválidos' });
    const added = sources.add(def);
    sources.refresh([added.id], true);
    return json(req, res, 200, { id: added.id });
  }

  mm = p.match(/^\/api\/sources\/([\w-]+)$/);
  if (mm && m === 'PATCH') {
    const b = await readBody(req, 4096);
    sources.setEnabled(mm[1], !!b.enabled);
    if (b.enabled) sources.refresh([mm[1]], false);
    return json(req, res, 200, { ok: true });
  }
  if (mm && m === 'DELETE') {
    return json(req, res, sources.remove(mm[1]) ? 200 : 400, { ok: true });
  }

  if (p === '/api/refresh' && m === 'POST') {
    const b = await readBody(req, 4096);
    sources.refresh(b.id ? [b.id] : null, true);
    return json(req, res, 200, { ok: true });
  }

  // ----- eventos em tempo real (TV receptora / controle remoto) -----
  if (p === '/api/events' && m === 'GET') {
    const id = (q.get('device') || '').replace(/[^\w-]/g, '').slice(0, 40) || 'anon' + Date.now();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const old = clients.get(id);
    if (old) { try { old.res.end(); } catch (e) { /* ok */ } }
    const c = { id: id, name: (q.get('name') || 'TV').slice(0, 40), role: q.get('role') === 'receiver' ? 'receiver' : 'controller', res: res, state: null, profile: profileOf(req, q).id };
    clients.set(id, c);
    send(c, 'hello', { id: id, devices: deviceList() });
    broadcast('devices', deviceList());
    req.on('close', function () {
      if (clients.get(id) === c) { clients.delete(id); broadcast('devices', deviceList()); }
    });
    return;
  }

  if (p === '/api/cast' && m === 'POST') {
    const b = await readBody(req, 8192);
    const t = clients.get(String(b.to || ''));
    if (!t || t.role !== 'receiver') return json(req, res, 404, { error: 'TV não está online' });
    send(t, 'command', { cmd: String(b.cmd || ''), data: b.data || {} });
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/device-state' && m === 'POST') {
    const b = await readBody(req, 8192);
    const c = clients.get(String(b.id || ''));
    if (c) { c.state = b.state || null; broadcast('devices', deviceList()); }
    return json(req, res, 200, { ok: true });
  }

  if (p.indexOf('/api/') === 0) return json(req, res, 404, { error: 'rota desconhecida' });
  return serveStatic(req, res, p);
}

const server = http.createServer(function (req, res) {
  route(req, res).catch(function (e) {
    if (!res.headersSent) json(req, res, 500, { error: e.message });
    else res.end();
  });
});
server.keepAliveTimeout = 5000;

// ---------- início ----------
(async function main() {
  server.listen(PORT, '0.0.0.0', function () {
    console.log('\n  IPTV pronto!  Abra no celular e na TV (mesmo Wi-Fi):\n');
    const urls = lanUrls();
    urls.forEach(function (x) { console.log('    ' + x); });
    console.log('    http://localhost:' + PORT + '  (este computador)\n');
    if (auth.enabled) console.log('  Login ativo (usuário: ' + auth.user + ').\n');
    else console.log('  ATENÇÃO: sem login. Use só na rede de casa. Para ativar: node set-login.js USUARIO SENHA\n');
  });
  await sources.loadCache();
  await rebuild();
  console.log('  Biblioteca: ' + JSON.stringify(library.totals()));
  sources.refresh(null, false).then(function () { console.log('  Fontes atualizadas.'); });
})();

module.exports = { server };
