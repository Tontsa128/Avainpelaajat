// HTTP-palvelin: reititys, tunnistautuminen, organisaation valinta, roolitarkistus, CORS ja staattinen etusivu.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Router, HttpError, readJson, send } from './http.js';
import { verifyToken, RateLimiter } from './auth.js';
import { registerRoutes } from './routes.js';
import { makeGeocoder } from './geocode.js';
import { registerImportRoutes } from './import.js';
import { registerSuperBookerRoutes } from './super-booker.js';

export function loadConfig(overrides = {}) {
  const env = process.env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let secret = overrides.jwtSecret || env.JWT_SECRET;
  const prod = env.NODE_ENV === 'production';
  if (!secret) {
    if (prod) throw new Error('JWT_SECRET puuttuu (pakollinen production-tilassa).');
    secret = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    console.warn('[config] JWT_SECRET puuttuu: käytetään väliaikaista kehitysavainta. Kirjautumiset nollautuvat uudelleenkäynnistyksessä.');
  }
  return {
    port: Number(env.PORT || 8080),
    dbPath: env.DB_PATH || path.join(here, 'data', 'avainpelaaja.db'),
    jwtSecret: secret,
    tokenTtlSec: Number(env.TOKEN_TTL_SEC || 60 * 60 * 24 * 14),
    corsOrigin: env.CORS_ORIGIN || '*',
    allowRegistration: env.ALLOW_REGISTRATION === 'true',
    staticDir: env.STATIC_DIR || path.join(here, '..'),
    bodyLimit: Number(env.BODY_LIMIT || 8 * 1024 * 1024),
    trustProxy: env.TRUST_PROXY === 'true',
    geocoderUrl: env.GEOCODER_URL === undefined ? 'https://nominatim.openstreetmap.org/search' : env.GEOCODER_URL,
    geocoderUserAgent: env.GEOCODER_USER_AGENT || 'AvainpelaajaOS/1.0 (ständimyynnin hallintajärjestelmä)',
    geocoderMinIntervalMs: Number(env.GEOCODER_MIN_INTERVAL_MS || 1100),
    aiApiKey: env.ANTHROPIC_API_KEY || '',
    aiApiUrl: env.AI_API_URL || 'https://api.anthropic.com/v1/messages',
    aiModel: env.AI_MODEL || 'claude-sonnet-4-6',
    ...overrides,
  };
}

export function createApp(config) {
  const db = openDb(config.dbPath);
  const router = new Router();
  const limiter = new RateLimiter(8, 15 * 60 * 1000);
  const importLimiter = new RateLimiter(20, 60 * 60 * 1000);
  registerRoutes(router, { db, config, limiter, geocoder: makeGeocoder(config) });
  registerImportRoutes(router, { config, limiter: importLimiter });
  registerSuperBookerRoutes(router, { db, config });

  const allowedOrigins = config.corsOrigin === '*' ? null : config.corsOrigin.split(',').map((s) => s.trim());

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!allowedOrigins) res.setHeader('access-control-allow-origin', '*');
    else if (origin && allowedOrigins.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); }
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-organization-id');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }

  function authenticate(ctx) {
    const h = ctx.req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    const payload = m ? verifyToken(m[1], config.jwtSecret) : null;
    if (!payload) throw new HttpError(401, 'unauthorized', 'Kirjautuminen vaaditaan.');
    const u = db.prepare('SELECT id,email,name,disabled FROM users WHERE id=?').get(payload.uid);
    if (!u || u.disabled) throw new HttpError(401, 'unauthorized', 'Kirjautuminen vaaditaan.');
    ctx.user = { id: u.id, email: u.email, name: u.name };
  }

  function resolveOrg(ctx) {
    let orgId = ctx.req.headers['x-organization-id'] || ctx.query.org || '';
    if (!orgId) {
      const ms = db.prepare('SELECT org_id FROM memberships WHERE user_id=?').all(ctx.user.id);
      if (ms.length === 1) orgId = ms[0].org_id;
      else throw new HttpError(400, 'org_required', 'Valitse organisaatio (x-organization-id).');
    }
    const m = db.prepare('SELECT role, seller_id FROM memberships WHERE user_id=? AND org_id=?').get(ctx.user.id, String(orgId));
    if (!m) throw new HttpError(403, 'forbidden', 'Sinulla ei ole pääsyä tähän organisaatioon.');
    ctx.orgId = String(orgId);
    ctx.role = m.role;
    ctx.sellerId = m.seller_id || null;
  }

  function serveStatic(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/super-buukkaaja.html') {
      const file = path.join(config.staticDir, 'super-buukkaaja.html');
      if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('super-buukkaaja.html puuttuu.'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Ei löytynyt');
    }
    const file = path.join(config.staticDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('index.html puuttuu (STATIC_DIR).');
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    const { route, params, pathMatched } = router.match(req.method, pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found', pathMatched ? 'Metodia ei tueta.' : 'Polkua ei löydy.');
    const fwd = config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ctx = { req, res, db, config, params, query: Object.fromEntries(url.searchParams), body: null, user: null, orgId: null, role: null, sellerId: null, status: 200, ip: fwd || req.socket.remoteAddress || '' };
    if (route.opts.auth !== false) authenticate(ctx);
    if (route.opts.org) resolveOrg(ctx);
    const roles = typeof route.opts.roles === 'function' ? route.opts.roles(ctx) : route.opts.roles;
    if (roles && !roles.includes(ctx.role)) throw new HttpError(403, 'forbidden', 'Roolillasi ei ole oikeutta tähän toimintoon.');
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await readJson(req, config.bodyLimit);
    const data = await route.handler(ctx);
    send(res, ctx.status, data);
  }

  function fail(res, err) {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof HttpError) {
      return send(res, err.status, { error: { code: err.code, message: err.message, details: err.details } }, err.status === 413 ? { connection: 'close' } : {});
    }
    console.error('[virhe]', err);
    send(res, 500, { error: { code: 'internal', message: 'Palvelinvirhe.' } });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => fail(res, e)); });
  server.on('close', () => { try { db.close(); } catch { /* jo suljettu */ } });
  return { server, db };
}
