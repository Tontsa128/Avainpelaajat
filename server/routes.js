// REST-rajapinta: kirjautuminen, organisaatio ja jäsenet, päätaulut, records ja työtilan synkronointi.
import { HttpError, reqStr, reqEmail, reqPassword, isId, isDate, isTime, isObj, bad } from './http.js';
import { hashPassword, verifyPassword, signToken } from './auth.js';
import { tx } from './db.js';
import * as store from './store.js';
import { newId } from './util.js';
import { registerSync } from './sync.js';
import { POI_KINDS, queryBbox, queryNear, poiStats } from './osm.js';
import { RateLimiter } from './auth.js';
import { planForSeller } from './ai-planner.js';
import { audit } from './audit.js';

export const ROLES = ['Admin', 'Buukkaaja', 'Esihenkilö', 'Myyjä', 'Raportointikäyttäjä'];
const WRITERS = ['Admin', 'Buukkaaja', 'Esihenkilö', 'Myyjä'];
/** Kuka saa kirjoittaa mihinkin kokoelmaan. Lukuoikeus on kaikilla organisaation jäsenillä (ks. READ_DENY). */
export const WRITE = {
  sellers: ['Admin', 'Esihenkilö'],
  places: ['Admin', 'Buukkaaja'],
  bookings: ['Admin', 'Buukkaaja', 'Esihenkilö'],
  time: ['Admin', 'Esihenkilö', 'Myyjä'],
  leads: ['Admin', 'Buukkaaja'],
  campaigns: ['Admin', 'Buukkaaja', 'Esihenkilö'],
  needs: ['Admin', 'Buukkaaja', 'Esihenkilö'],
  bulletin: ['Admin', 'Buukkaaja', 'Esihenkilö'],
  incidents: WRITERS, swaps: WRITERS, notifications: WRITERS, audit: WRITERS,
};
/** Tietojen minimointi: mitä roolia ei näytetä. */
const READ_DENY = { 'Myyjä': ['leads', 'audit'], 'Raportointikäyttäjä': ['audit'] };
const FRONT_KINDS = new Set(['notifications', 'audit', 'bulletin', 'incidents', 'swaps']); // uusin ensin
const SETTINGS_DEFAULT = { labourCostH: 19, targetPerShift: 8, maxShiftH: 10, gps: false, travelKmh: 60 };

const VALID = {
  sellers: (o) => {
    reqStr(o.name, 'name', 1, 120);
    if (o.home !== undefined && o.home !== null) {
      const h = o.home;
      if (!isObj(h)) throw bad('Kenttä "home" on virheellinen.');
      if (h.address !== undefined && (typeof h.address !== 'string' || h.address.length > 200)) throw bad('Kotiosoite on virheellinen.');
      const okNum = (v, lo, hi) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
      if (!okNum(h.lat, -90, 90) || !okNum(h.lon, -180, 180)) throw bad('Kotiosoitteen koordinaatit ovat virheelliset.');
    }
    if (o.radiusKm !== undefined && o.radiusKm !== null && !(typeof o.radiusKm === 'number' && o.radiusKm >= 1 && o.radiusKm <= 500)) throw bad('Kenttä "radiusKm" pitää olla 1–500.');
  },
  places: (o) => {
    reqStr(o.name, 'name', 1, 160);
    if (o.stands !== undefined) {
      if (!Array.isArray(o.stands)) throw bad('Kenttä "stands" on virheellinen.');
      for (const s of o.stands) {
        if (!isObj(s) || typeof s.id !== 'string' || !s.id) throw bad('Ständillä pitää olla tunniste.');
        if (s.capacity !== undefined && !(Number.isInteger(s.capacity) && s.capacity >= 1 && s.capacity <= 4)) throw bad('Ständin "capacity" pitää olla kokonaisluku 1–4.');
      }
    }
  },
  bookings: (o) => {
    if (!isDate(o.date)) throw bad('Kenttä "date" on virheellinen (VVVV-KK-PP).');
    if (!isTime(o.start) || !isTime(o.end)) throw bad('Kentät "start" ja "end" ovat virheellisiä (HH:MM).');
    if (!isId(o.sellerId) || !isId(o.placeId)) throw bad('Kentät "sellerId" ja "placeId" puuttuvat.');
    if (o.status && !['confirmed', 'tentative'].includes(o.status)) throw bad('Kenttä "status" on virheellinen.');
  },
};

const forbidden = () => new HttpError(403, 'forbidden', 'Roolillasi ei ole oikeutta tähän toimintoon.');
const jparse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
\n
/** Tietojen minimointi: Myyjä näkee omat tietonsa kokonaan, muiden vain tarpeellisen. */
const stripHome = (s) => { const { home, radiusKm, ...rest } = s; void home; void radiusKm; return rest; };
function redact(kind, items, ctx) {
  // Kotiosoite ja työskentelysäde ovat vain buukkaajan, esihenkilön ja ylläpitäjän työkaluja.
  if (kind === 'sellers' && (ctx.role === 'Myyjä' || ctx.role === 'Raportointikäyttäjä')) items = items.map(stripHome);
  if (ctx.role !== 'Myyjä') return items;
  const me = ctx.sellerId;
  if (kind === 'sellers') return items.map((s) => (s.id === me ? s : { ...s, phone: '', email: '', restrictions: '', absences: [] }));
  if (kind === 'bookings') {
    return items.map((b) => (b.sellerId === me ? b
      : { id: b.id, date: b.date, start: b.start, end: b.end, sellerId: b.sellerId, placeId: b.placeId, stand: b.stand, status: b.status, campaign: b.campaign || '' }));
  }
  if (kind === 'time') return items.filter((t) => t.sellerId === me);
  return items;
}

/** Myyjän kirjoitusoikeus: vain omat aikamerkinnät, omat poikkeamat ja omat vuoronvaihdot. Ilmoituksiin vain lisäys. */
function ownsRecord(kind, obj, ctx) {
  const me = ctx.sellerId;
  if (!me) return false;
  switch (kind) {
    case 'time': return obj.sellerId === me;
    case 'incidents': return obj.sellerId === me;
    case 'swaps': return obj.from === me || obj.to === me;
    case 'notifications': return true;
    default: return false;
  }
}
function myyjaMayWrite(kind, obj, existing, ctx) {
  if (!ownsRecord(kind, obj, ctx)) return false;
  if (existing) {
    if (kind === 'notifications') return false;
    if (!ownsRecord(kind, existing, ctx)) return false;
  }
  if (kind === 'swaps' && obj.status === 'vahvistettu' && (!existing || existing.status !== 'vahvistettu')) return false;
  return true;
}
const unlinkMissingSellers = (db, orgId) => db.prepare(
  'UPDATE memberships SET seller_id=NULL WHERE org_id=? AND seller_id IS NOT NULL AND seller_id NOT IN (SELECT id FROM sellers WHERE org_id=?)').run(orgId, orgId);

function bookingProblems(db, orgId, b, ignoreId) {
  const out = [];
  if (!store.entityExists(db, orgId, 'sellers', b.sellerId)) out.push({ code: 'seller_missing', message: 'Myyjää ei löydy.' });
  if (!store.entityExists(db, orgId, 'places', b.placeId)) out.push({ code: 'place_missing', message: 'Kauppapaikkaa ei löydy.' });
  return out.concat(store.findBookingConflicts(db, orgId, b, ignoreId));
}

function sessionFor(db, config, userId) {
  const u = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(userId);
  const memberships = db.prepare(`SELECT m.org_id AS orgId, o.name AS orgName, m.role AS role, m.seller_id AS sellerId
    FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? ORDER BY o.name`).all(userId);
  return {
    token: signToken({ uid: userId }, config.jwtSecret, config.tokenTtlSec),
    user: { id: u.id, email: u.email, name: u.name },
    memberships: memberships.map((m) => ({ ...m })),
  };
}

function buildState(db, ctx) {
  const org = db.prepare('SELECT id,name,settings,rev FROM organizations WHERE id=?').get(ctx.orgId);
  const deny = READ_DENY[ctx.role] || [];
  const state = {
    v: 1, mode: 'work', user: ctx.user.name, org: org.name, role: ctx.role,
    settings: { ...SETTINGS_DEFAULT, ...jparse(org.settings, {}) },
  };
  for (const k of store.ENTITY_KINDS) state[k] = redact(k, store.listEntity(db, ctx.orgId, k), ctx);
  for (const k of store.RECORD_KINDS) state[k] = deny.includes(k) ? [] : redact(k, store.listRecords(db, ctx.orgId, k), ctx);
  return { rev: org.rev, org: { id: org.id, name: org.name }, role: ctx.role, sellerId: ctx.sellerId, state };
}

export function registerRoutes(router, { db, config, limiter, geocoder }) {
  const geoLimiter = new RateLimiter(60, 10 * 60 * 1000);
  let dummyHash = null;
  const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

  /* ---------- Terveys ---------- */
  router.get('/api/health', { auth: false }, () => ({ ok: true, time: new Date().toISOString(), version: '1.0.0' }));
  router.get('/api/health/db', { auth: false }, () => { db.prepare('SELECT 1').get(); return { ok: true }; });

  /* ---------- Kirjautuminen ---------- */
  router.post('/api/auth/register', { auth: false }, async (ctx) => {
    if (!config.allowRegistration && userCount() > 0) {
      throw new HttpError(403, 'registration_closed', 'Rekisteröityminen on suljettu. Pyydä ylläpitäjää lisäämään sinut jäseneksi.');
    }
    const b = ctx.body || {};
    const email = reqEmail(b.email), name = reqStr(b.name, 'name', 1, 80), orgName = reqStr(b.organization, 'organization', 1, 120);
    const password = reqPassword(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'email_taken', 'Sähköposti on jo käytössä.');
    const hash = await hashPassword(password);
    const userId = newId('u'), orgId = newId('o'), now = Date.now();
    try {
      tx(db, () => {
        db.prepare('INSERT INTO organizations(id,name,settings,rev,created_at) VALUES(?,?,?,?,?)').run(orgId, orgName, '{}', 0, now);
        db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(userId, email, name, hash, now);
        db.prepare('INSERT INTO memberships(user_id,org_id,role) VALUES(?,?,?)').run(userId, orgId, 'Admin');
        audit(db, orgId, userId, 'org.create', { name: orgName });
      });
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'email_taken', 'Sähköposti on jo käytössä.');
      throw e;
    }
    ctx.status = 201;
    return sessionFor(db, config, userId);
  });

  router.post('/api/auth/login', { auth: false }, async (ctx) => {
    const b = ctx.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const key = `${ctx.ip}|${email}`;
    if (!limiter.hit(key)) throw new HttpError(429, 'too_many_attempts', 'Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen.');
    const u = db.prepare('SELECT id,password_hash,disabled FROM users WHERE email=?').get(email);
    if (!dummyHash) dummyHash = await hashPassword('dummy-password');
    const ok = await verifyPassword(String(b.password || ''), u ? u.password_hash : dummyHash);
    if (!u || !ok || u.disabled) throw new HttpError(401, 'invalid_credentials', 'Sähköposti tai salasana on väärin.');
    limiter.reset(key);
    return sessionFor(db, config, u.id);
  });

  router.get('/api/me', {}, (ctx) => sessionFor(db, config, ctx.user.id));

  router.post('/api/auth/password', {}, async (ctx) => {
    const b = ctx.body || {};
    const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(ctx.user.id);
    if (!(await verifyPassword(String(b.current || ''), u.password_hash))) throw new HttpError(401, 'invalid_credentials', 'Nykyinen salasana on väärin.');
    const hash = await hashPassword(reqPassword(b.next));
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, ctx.user.id);
    return { ok: true };
  });

  /* ---------- Organisaatio ja jäsenet ---------- */
  router.get('/api/org', { org: true }, (ctx) => {
    const o = db.prepare('SELECT id,name,rev FROM organizations WHERE id=?').get(ctx.orgId);
    return { id: o.id, name: o.name, rev: o.rev, role: ctx.role };
  });
  router.patch('/api/org', { org: true, roles: ['Admin'] }, (ctx) => {
    const name = reqStr((ctx.body || {}).name, 'name', 1, 120);
    db.prepare('UPDATE organizations SET name=? WHERE id=?').run(name, ctx.orgId);
    audit(db, ctx.orgId, ctx.user.id, 'org.rename', { name });
    return { id: ctx.orgId, name };
  });

  router.get('/api/org/members', { org: true, roles: ['Admin'] }, (ctx) =>
    ({ items: db.prepare(`SELECT u.id AS userId, u.email AS email, u.name AS name, m.role AS role, m.seller_id AS sellerId
      FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY u.name`).all(ctx.orgId).map((r) => ({ ...r })) }));

  router.post('/api/org/members', { org: true, roles: ['Admin'] }, async (ctx) => {
    const b = ctx.body || {};
    const email = reqEmail(b.email);
    if (!ROLES.includes(b.role)) throw bad('Rooli on virheellinen.');
    const linkTo = b.sellerId || null;
    if (linkTo) {
      if (!store.entityExists(db, ctx.orgId, 'sellers', linkTo)) throw new HttpError(404, 'not_found', 'Myyjää ei löydy.');
      if (db.prepare('SELECT 1 FROM memberships WHERE org_id=? AND seller_id=?').get(ctx.orgId, linkTo)) throw new HttpError(409, 'seller_taken', 'Myyjäprofiili on jo linkitetty toiselle käyttäjälle.');
    }
    let u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (u && db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND org_id=?').get(u.id, ctx.orgId)) {
      throw new HttpError(409, 'already_member', 'Käyttäjä on jo organisaation jäsen.');
    }
    let hash = null, name = null;
    if (!u) { name = reqStr(b.name, 'name', 1, 80); hash = await hashPassword(reqPassword(b.password)); }
    tx(db, () => {
      if (!u) {
        const id = newId('u');
        db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(id, email, name, hash, Date.now());
        u = { id };
      }
      db.prepare('INSERT INTO memberships(user_id,org_id,role,seller_id) VALUES(?,?,?,?)').run(u.id, ctx.orgId, b.role, linkTo);
      audit(db, ctx.orgId, ctx.user.id, 'member.add', { email, role: b.role, sellerId: linkTo });
    });
    ctx.status = 201;
    return { userId: u.id, email, role: b.role, sellerId: linkTo };
  });

  const adminCount = (orgId) => db.prepare("SELECT COUNT(*) n FROM memberships WHERE org_id=? AND role='Admin'").get(orgId).n;
  router.patch('/api/org/members/:userId', { org: true, roles: ['Admin'] }, (ctx) => {
    const b = ctx.body || {};
    const m = db.prepare('SELECT role, seller_id FROM memberships WHERE user_id=? AND org_id=?').get(ctx.params.userId, ctx.orgId);
    if (!m) throw new HttpError(404, 'not_found', 'Jäsentä ei löydy.');
    const hasRole = b.role !== undefined, hasSeller = b.sellerId !== undefined;
    if (!hasRole && !hasSeller) throw bad('Anna "role" ja/tai "sellerId".');
    let role = m.role, sellerId = m.seller_id || null;
    if (hasRole) {
      if (!ROLES.includes(b.role)) throw bad('Rooli on virheellinen.');
      if (m.role === 'Admin' && b.role !== 'Admin' && adminCount(ctx.orgId) <= 1) throw new HttpError(409, 'last_admin', 'Organisaatiolla pitää olla vähintään yksi Admin.');
      role = b.role;
    }
    if (hasSeller) {
      sellerId = b.sellerId || null;
      if (sellerId) {
        if (!store.entityExists(db, ctx.orgId, 'sellers', sellerId)) throw new HttpError(404, 'not_found', 'Myyjää ei löydy.');
        if (db.prepare('SELECT 1 FROM memberships WHERE org_id=? AND seller_id=? AND user_id<>?').get(ctx.orgId, sellerId, ctx.params.userId)) {
          throw new HttpError(409, 'seller_taken', 'Myyjäprofiili on jo linkitetty toiselle käyttäjälle.');
        }
      }
    }
    db.prepare('UPDATE memberships SET role=?, seller_id=? WHERE user_id=? AND org_id=?').run(role, sellerId, ctx.params.userId, ctx.orgId);
    audit(db, ctx.orgId, ctx.user.id, 'member.update', { userId: ctx.params.userId, role, sellerId });
    return { userId: ctx.params.userId, role, sellerId };
  });
  router.delete('/api/org/members/:userId', { org: true, roles: ['Admin'] }, (ctx) => {
    const m = db.prepare('SELECT role FROM memberships WHERE user_id=? AND org_id=?').get(ctx.params.userId, ctx.orgId);
    if (!m) throw new HttpError(404, 'not_found', 'Jäsentä ei löydy.');
    if (m.role === 'Admin' && adminCount(ctx.orgId) <= 1) throw new HttpError(409, 'last_admin', 'Viimeistä Admin-käyttäjää ei voi poistaa.');
    db.prepare('DELETE FROM memberships WHERE user_id=? AND org_id=?').run(ctx.params.userId, ctx.orgId);
    audit(db, ctx.orgId, ctx.user.id, 'member.remove', { userId: ctx.params.userId });
    return { ok: true };
  });

  router.get('/api/audit', { org: true, roles: ['Admin', 'Esihenkilö'] }, (ctx) => {
    const limit = Math.min(500, Math.max(1, Number(ctx.query.limit) || 100));
    return { items: db.prepare(`SELECT a.id AS id, a.ts AS ts, a.action AS action, a.detail AS detail, u.email AS user
      FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.org_id=? ORDER BY a.id DESC LIMIT ?`).all(ctx.orgId, limit).map((r) => ({ ...r })) };
  });

  /* ---------- Myyjät, kohteet, varaukset ---------- */
  for (const kind of store.ENTITY_KINDS) {
    const base = `/api/${kind}`;
    router.get(base, { org: true }, (ctx) => {
      const q = {};
      if (kind === 'bookings') {
        if (ctx.query.from) { if (!isDate(ctx.query.from)) throw bad('from'); q.from = ctx.query.from; }
        if (ctx.query.to) { if (!isDate(ctx.query.to)) throw bad('to'); q.to = ctx.query.to; }
      }
      return { items: redact(kind, store.listEntity(db, ctx.orgId, kind, q), ctx) };
    });
    router.get(`${base}/:id`, { org: true }, (ctx) => {
      const r = store.getEntityRow(db, ctx.orgId, kind, ctx.params.id);
      if (!r) throw new HttpError(404, 'not_found', 'Tietuetta ei löydy.');
      return redact(kind, [r.obj], ctx)[0];
    });
    router.post(base, { org: true, roles: WRITE[kind] }, (ctx) => {
      const o = ctx.body;
      if (!isObj(o)) throw bad('Runko puuttuu.');
      const obj = { ...o };
      if (obj.id !== undefined && !isId(obj.id)) throw bad('id on virheellinen.');
      if (!obj.id) obj.id = newId(store.prefixOf(kind));
      VALID[kind](obj);
      if (store.entityExists(db, ctx.orgId, kind, obj.id)) throw new HttpError(409, 'exists', 'Tietue on jo olemassa.');
      if (kind === 'bookings') {
        const p = bookingProblems(db, ctx.orgId, obj, '');
        if (p.length) throw new HttpError(409, 'booking_conflict', 'Varaus on ristiriidassa.', { conflicts: p });
      }
      tx(db, () => {
        store.upsertEntity(db, ctx.orgId, kind, obj, store.nextPos(db, ctx.orgId, kind));
        store.bumpRev(db, ctx.orgId);
        audit(db, ctx.orgId, ctx.user.id, `${kind}.create`, { id: obj.id });
      });
      ctx.status = 201;
      return obj;
    });
    router.patch(`${base}/:id`, { org: true, roles: WRITE[kind] }, (ctx) => {
      const ex = store.getEntityRow(db, ctx.orgId, kind, ctx.params.id);
      if (!ex) throw new HttpError(404, 'not_found', 'Tietuetta ei löydy.');
      if (!isObj(ctx.body)) throw bad('Runko puuttuu.');
      const obj = { ...ex.obj, ...ctx.body, id: ex.obj.id };
      VALID[kind](obj);
      if (kind === 'bookings') {
        const p = bookingProblems(db, ctx.orgId, obj, obj.id);
        if (p.length) throw new HttpError(409, 'booking_conflict', 'Varaus on ristiriidassa.', { conflicts: p });
      }
      tx(db, () => {
        store.upsertEntity(db, ctx.orgId, kind, obj, ex.pos);
        store.bumpRev(db, ctx.orgId);
        audit(db, ctx.orgId, ctx.user.id, `${kind}.update`, { id: obj.id });
      });
      return obj;
    });
    router.delete(`${base}/:id`, { org: true, roles: WRITE[kind] }, (ctx) => {
      if (kind === 'sellers' || kind === 'places') {
        const n = store.countBookingsFor(db, ctx.orgId, kind === 'sellers' ? 'seller' : 'place', ctx.params.id);
        if (n > 0) throw new HttpError(409, 'in_use', `Tietuetta ei voi poistaa: siihen liittyy ${n} varausta.`);
      }
      if (!store.deleteEntity(db, ctx.orgId, kind, ctx.params.id)) throw new HttpError(404, 'not_found', 'Tietuetta ei löydy.');
      if (kind === 'sellers') unlinkMissingSellers(db, ctx.orgId);
      store.bumpRev(db, ctx.orgId);
      audit(db, ctx.orgId, ctx.user.id, `${kind}.delete`, { id: ctx.params.id });
      return { ok: true };
    });
  }

  /* ---------- Muut kokoelmat (CRM, kampanjat, aikamerkinnät, ...) ---------- */
  const kindOf = (ctx) => {
    const k = ctx.params.kind;
    if (!store.RECORD_KINDS.includes(k)) throw new HttpError(404, 'not_found', 'Tuntematon kokoelma.');
    return k;
  };
  const writeRoles = (ctx) => WRITE[kindOf(ctx)];
  router.get('/api/records/:kind', { org: true }, (ctx) => {
    const k = kindOf(ctx);
    if ((READ_DENY[ctx.role] || []).includes(k)) throw forbidden();
    return { items: redact(k, store.listRecords(db, ctx.orgId, k), ctx) };
  });
  router.post('/api/records/:kind', { org: true, roles: writeRoles }, (ctx) => {
    const k = kindOf(ctx);
    if (!isObj(ctx.body)) throw bad('Runko puuttuu.');
    const obj = { ...ctx.body };
    if (obj.id !== undefined && !isId(obj.id)) throw bad('id on virheellinen.');
    if (!obj.id) obj.id = newId(store.prefixOf(k));
    if (store.getRecordRow(db, ctx.orgId, k, obj.id)) throw new HttpError(409, 'exists', 'Tietue on jo olemassa.');
    if (ctx.role === 'Myyjä' && !myyjaMayWrite(k, obj, null, ctx)) throw forbidden();
    tx(db, () => {
      store.upsertRecord(db, ctx.orgId, k, obj, FRONT_KINDS.has(k) ? store.prevPos(db, ctx.orgId, k) : store.nextPos(db, ctx.orgId, k));
      store.bumpRev(db, ctx.orgId);
      audit(db, ctx.orgId, ctx.user.id, `${k}.create`, { id: obj.id });
    });
    ctx.status = 201;
    return obj;
  });
  router.patch('/api/records/:kind/:id', { org: true, roles: writeRoles }, (ctx) => {
    const k = kindOf(ctx);
    const ex = store.getRecordRow(db, ctx.orgId, k, ctx.params.id);
    if (!ex) throw new HttpError(404, 'not_found', 'Tietuetta ei löydy.');
    if (!isObj(ctx.body)) throw bad('Runko puuttuu.');
    const obj = { ...ex.obj, ...ctx.body, id: ex.obj.id };
    if (ctx.role === 'Myyjä' && !myyjaMayWrite(k, obj, ex.obj, ctx)) throw forbidden();
    store.upsertRecord(db, ctx.orgId, k, obj, ex.pos);
    store.bumpRev(db, ctx.orgId);
    audit(db, ctx.orgId, ctx.user.id, `${k}.update`, { id: obj.id });
    return obj;
  });
  router.delete('/api/records/:kind/:id', { org: true, roles: writeRoles }, (ctx) => {
    const k = kindOf(ctx);
    if (ctx.role === 'Myyjä') throw forbidden();
    if (!store.deleteRecord(db, ctx.orgId, k, ctx.params.id)) throw new HttpError(404, 'not_found', 'Tietuetta ei löydy.');
    store.bumpRev(db, ctx.orgId);
    audit(db, ctx.orgId, ctx.user.id, `${k}.delete`, { id: ctx.params.id });
    return { ok: true };
  });

  /* ---------- OpenStreetMap-paikat ja osoitehaku (buukkarin työkaluja) ---------- */
  const PLANNERS = ['Admin', 'Buukkaaja', 'Esihenkilö'];
  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw bad(`Parametri "${name}" puuttuu tai on virheellinen.`); return n; };
  const kindsOf = (v) => (v ? String(v).split(',').filter((k) => k in POI_KINDS) : []);
  router.get('/api/pois/stats', { org: true, roles: PLANNERS }, () => ({ ...poiStats(db), kinds: POI_KINDS }));
  router.get('/api/pois', { org: true, roles: PLANNERS }, (ctx) => {
    const p = String(ctx.query.bbox || '').split(',').map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw bad('Parametri "bbox" pitää olla länsi,etelä,itä,pohjoinen.');
    const [west, south, east, north] = p;
    return { items: queryBbox(db, { west, south, east, north, kinds: kindsOf(ctx.query.kinds), q: ctx.query.q ? String(ctx.query.q).slice(0, 80) : '', limit: Number(ctx.query.limit) || 2000 }), attribution: '© OpenStreetMap contributors' };
  });
  router.get('/api/pois/near', { org: true, roles: PLANNERS }, (ctx) => {
    const km = num(ctx.query.km || 100, 'km');
    if (km < 1 || km > 500) throw bad('Parametri "km" pitää olla 1–500.');
    return { items: queryNear(db, { lat: num(ctx.query.lat, 'lat'), lon: num(ctx.query.lon, 'lon'), km, kinds: kindsOf(ctx.query.kinds), limit: Number(ctx.query.limit) || 200 }), attribution: '© OpenStreetMap contributors' };
  });
  router.post('/api/geocode', { org: true, roles: PLANNERS }, async (ctx) => {
    if (!geoLimiter.hit(ctx.user.id)) throw new HttpError(429, 'too_many_attempts', 'Liian monta osoitehakua. Yritä myöhemmin uudelleen.');
    const q = reqStr((ctx.body || {}).q, 'q', 3, 200);
    return geocoder(q);
  });

  /* ---------- AI-suunnittelija: ehdottaa kuukausikalenterin ---------- */
  router.post('/api/ai/month-plan', { org: true, roles: PLANNERS }, (ctx) => {
    const b = ctx.body || {};
    const sellerId = reqStr(b.sellerId, 'sellerId', 1, 120);
    const seller = store.getEntityRow(db, ctx.orgId, 'sellers', sellerId)?.obj;
    if (!seller) throw new HttpError(404, 'seller_missing', 'Myyjää ei löydy.');
    const year = Number(b.year), month = Number(b.month);
    if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw bad('Vuosi tai kuukausi on virheellinen.');
    const places = store.listEntity(db, ctx.orgId, 'places');
    const bookings = store.listEntity(db, ctx.orgId, 'bookings');
    const salesHistory = store.listRecords(db, ctx.orgId, 'time').map((x) => ({ ...x, sales: x.sales ?? x.salesCount ?? 0, hours: x.hours ?? x.workHours ?? 0, placeId: x.placeId }));
    return planForSeller({ seller, places, bookings, salesHistory, year, month, options: {
      radiusKm: Number(b.radiusKm || seller.radiusKm || 100), minBlockDays: Number(b.minBlockDays || 1), maxBlockDays: Number(b.maxBlockDays || 2),
      avoidWeekends: !!b.avoidWeekends, maxCandidates: Number(b.maxCandidates || 50),
    }});
  });

  /* ---------- Työtila: koko datan haku ja synkronointi (käyttöliittymä käyttää tätä) ---------- */
  router.get('/api/workspace', { org: true }, (ctx) => {
    if (ctx.query.since !== undefined) {
      const o = db.prepare('SELECT rev FROM organizations WHERE id=?').get(ctx.orgId);
      if (String(o.rev) === String(ctx.query.since)) return { rev: o.rev, unchanged: true };
    }
    return buildState(db, ctx);
  });

  /** Koko työtilan korvaus (alkusiirto ja varmuuskopion tuonti). Vain Admin. Tavallinen tallennus käyttää POST /api/sync. */
  router.put('/api/workspace', { org: true, roles: ['Admin'] }, (ctx) => {
    const b = ctx.body;
    if (!isObj(b) || !isObj(b.state)) throw bad('Kenttä "state" puuttuu.');
    const st = b.state;
    const incoming = {};
    for (const k of [...store.ENTITY_KINDS, ...store.RECORD_KINDS]) {
      if (st[k] === undefined) continue;
      if (!Array.isArray(st[k])) throw bad(`Kokoelma "${k}" ei ole lista.`);
      if (st[k].length > 50000) throw bad(`Kokoelma "${k}" on liian suuri.`);
      const ids = new Set();
      for (const it of st[k]) {
        if (!isObj(it) || !isId(it.id)) throw bad(`Kokoelman "${k}" alkiolla ei ole kelvollista id:tä.`);
        if (ids.has(it.id)) throw bad(`Kokoelmassa "${k}" on kaksi samaa id:tä.`);
        ids.add(it.id);
        if (VALID[k]) VALID[k](it);
      }
      incoming[k] = st[k];
    }
    return tx(db, () => {
      const org = db.prepare('SELECT rev FROM organizations WHERE id=?').get(ctx.orgId);
      if (b.baseRev !== org.rev) throw new HttpError(409, 'rev_mismatch', 'Toinen käyttäjä on päivittänyt tietoja.', { rev: org.rev });
      const summary = {};
      for (const [k, items] of Object.entries(incoming)) {
        summary[k] = store.replaceCollection(db, ctx.orgId, k, items);
        if (k === 'sellers') unlinkMissingSellers(db, ctx.orgId);
      }
      const changed = summary.bookings ? summary.bookings.changedIds : [];
      if (changed.length) {
        const byId = new Map(incoming.bookings.map((x) => [x.id, x]));
        const conflicts = [];
        for (const id of changed) {
          const bk = byId.get(id);
          for (const p of bookingProblems(db, ctx.orgId, bk, bk.id)) conflicts.push({ bookingId: id, ...p });
        }
        if (conflicts.length) throw new HttpError(409, 'booking_conflict', 'Varaukset ovat ristiriidassa.', { conflicts: conflicts.slice(0, 20) });
      }
      if (isObj(st.settings)) {
        const s = {};
        for (const k of Object.keys(SETTINGS_DEFAULT)) {
          if (st.settings[k] === undefined) continue;
          s[k] = typeof SETTINGS_DEFAULT[k] === 'boolean' ? !!st.settings[k] : (Number(st.settings[k]) || SETTINGS_DEFAULT[k]);
        }
        db.prepare('UPDATE organizations SET settings=? WHERE id=?').run(JSON.stringify(s), ctx.orgId);
      }
      const rev = org.rev + 1;
      db.prepare('UPDATE organizations SET rev=? WHERE id=?').run(rev, ctx.orgId);
      const counts = {};
      for (const [k, v] of Object.entries(summary)) if (v.added || v.updated || v.removed) counts[k] = `+${v.added} ~${v.updated} -${v.removed}`;
      if (Object.keys(counts).length) audit(db, ctx.orgId, ctx.user.id, 'workspace.sync', counts);
      return { rev };
    });
  });

  registerSync(router, { db, config }, {
    VALID, READ_DENY, WRITE, SETTINGS_DEFAULT, redact, myyjaMayWrite, bookingProblems, unlinkMissingSellers, audit, jparse,
  });
}
