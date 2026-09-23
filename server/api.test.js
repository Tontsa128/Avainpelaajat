import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, loadConfig } from './app.js';
import { hashStr } from './util.js';
import http from 'node:http';
import fs from 'node:fs';
import { parseOverpass, replacePois } from './osm.js';

let server, base, mainDb, geoStub;
test.before(async () => {
  // Paikallinen osoitehaun esikuva: ei verkkoyhteyttä testeissä
  geoStub = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(q.includes('Testikatu') ? [{ lat: '61.497753', lon: '23.760954', display_name: 'Testikatu 1, Tampere' }] : []));
  });
  await new Promise((r) => geoStub.listen(0, r));
  const cfg = loadConfig({ dbPath: ':memory:', jwtSecret: 'test-secret', allowRegistration: false, geocoderUrl: `http://127.0.0.1:${geoStub.address().port}/search`, geocoderMinIntervalMs: 0 });
  ({ server, db: mainDb } = createApp(cfg));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => geoStub.close(r)); });

async function api(method, path, { token, org, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (org) headers['x-organization-id'] = org;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ei JSON */ }
  return { status: res.status, json };
}


const H = (o) => hashStr(JSON.stringify(o));
/** Lähettää inkrementaalisen synkronoinnin. up: {kind: [[item, baseObj|null], ...]}, del: {kind: [[id, baseObj], ...]} */
function syncBody(up = {}, del = {}, extra = {}) {
  const changes = {};
  for (const [k, list] of Object.entries(up)) (changes[k] = changes[k] || { upsert: [], delete: [] }).upsert = list.map(([item, base]) => ({ item, base: base ? H(base) : null }));
  for (const [k, list] of Object.entries(del)) (changes[k] = changes[k] || { upsert: [], delete: [] }).delete = list.map(([id, base]) => ({ id, base: H(base) }));
  return { changes, ...extra };
}
const doSync = (token, org, up, del, extra) => api('POST', '/api/sync', { token, org, body: syncBody(up, del, extra) });

const ctx = {};
const seller = (id, name) => ({ id, name, phone: '040 1', email: `${id}@example.fi`, active: true, team: 'A', absences: [], restrictions: 'x' });
const place = (id, name) => ({ id, name, city: 'Tampere', region: 'Pirkanmaa', stands: [{ id: 'A', capacity: 1 }, { id: 'B', capacity: 1 }] });
const booking = (id, sellerId, placeId, stand, start, end, date = '2026-10-01') => ({ id, date, start, end, sellerId, placeId, stand, status: 'confirmed', deals: 0, log: [], report: null });

test('terveystarkistus toimii ilman kirjautumista', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal((await api('GET', '/api/health/db')).json.ok, true);
});

test('suojatut polut vaativat kirjautumisen', async () => {
  assert.equal((await api('GET', '/api/sellers')).status, 401);
  assert.equal((await api('GET', '/api/sellers', { token: 'roskaa' })).status, 401);
});

test('ensimmäinen rekisteröityminen luo organisaation, toinen suljetaan', async () => {
  const r = await api('POST', '/api/auth/register', { body: { email: 'Admin@Example.fi', name: 'Toni', password: 'salasana123', organization: 'Avainpelaaja Oy' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.memberships[0].role, 'Admin');
  ctx.admin = r.json.token;
  ctx.orgA = r.json.memberships[0].orgId;
  const r2 = await api('POST', '/api/auth/register', { body: { email: 'toinen@example.fi', name: 'X', password: 'salasana123', organization: 'Toinen Oy' } });
  assert.equal(r2.status, 403);
  assert.equal(r2.json.error.code, 'registration_closed');
});

test('validointi: liian lyhyt salasana ja väärä sähköposti', async () => {
  const cfg = loadConfig({ dbPath: ':memory:', jwtSecret: 's', allowRegistration: true });
  const { server: s2 } = createApp(cfg);
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const post = (body) => fetch(b2 + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ email: 'a@b.fi', name: 'A', password: 'lyhyt', organization: 'O' })).status, 400);
  assert.equal((await post({ email: 'ei-sähköposti', name: 'A', password: 'pitkäsalasana', organization: 'O' })).status, 400);
  assert.equal((await post({ email: 'a@b.fi', name: 'A', password: 'pitkäsalasana', organization: 'O' })).status, 201);
  assert.equal((await post({ email: 'a@b.fi', name: 'A', password: 'pitkäsalasana', organization: 'O2' })).status, 409);
  await new Promise((r) => s2.close(r));
});

test('kirjautuminen: väärä salasana hylätään, oikea toimii', async () => {
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'admin@example.fi', password: 'väärä-salasana' } })).status, 401);
  const r = await api('POST', '/api/auth/login', { body: { email: 'admin@example.fi', password: 'salasana123' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  const me = await api('GET', '/api/me', { token: r.json.token });
  assert.equal(me.json.user.email, 'admin@example.fi');
});

test('kirjautumisyritykset rajoitetaan', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await api('POST', '/api/auth/login', { body: { email: 'rajoitus@example.fi', password: 'x' } });
  assert.equal(last.status, 429);
});

test('myyjät ja kohteet: luonti, haku, päivitys', async () => {
  const { admin: token, orgA: org } = ctx;
  assert.equal((await api('POST', '/api/sellers', { token, org, body: seller('s1', 'Anna') })).status, 201);
  assert.equal((await api('POST', '/api/sellers', { token, org, body: seller('s2', 'Ben') })).status, 201);
  assert.equal((await api('POST', '/api/sellers', { token, org, body: seller('s1', 'Anna') })).status, 409);
  assert.equal((await api('POST', '/api/places', { token, org, body: place('p1', 'Ratina') })).status, 201);
  assert.equal((await api('POST', '/api/sellers', { token, org, body: { phone: '1' } })).status, 400);
  const list = await api('GET', '/api/sellers', { token, org });
  assert.equal(list.json.items.length, 2);
  const patched = await api('PATCH', '/api/sellers/s1', { token, org, body: { phone: '050 999' } });
  assert.equal(patched.json.phone, '050 999');
  assert.equal(patched.json.name, 'Anna');
});

test('varaukset: päällekkäisyys estetään (myyjä ja ständi)', async () => {
  const { admin: token, orgA: org } = ctx;
  assert.equal((await api('POST', '/api/bookings', { token, org, body: booking('b1', 's1', 'p1', 'A', '10:00', '18:00') })).status, 201);
  const sameSeller = await api('POST', '/api/bookings', { token, org, body: booking('b2', 's1', 'p1', 'B', '12:00', '16:00') });
  assert.equal(sameSeller.status, 409);
  assert.equal(sameSeller.json.error.details.conflicts[0].code, 'seller');
  const sameStand = await api('POST', '/api/bookings', { token, org, body: booking('b3', 's2', 'p1', 'A', '17:00', '19:00') });
  assert.equal(sameStand.status, 409);
  assert.equal(sameStand.json.error.details.conflicts[0].code, 'stand');
  // vierekkäin ilman päällekkäisyyttä: ok
  assert.equal((await api('POST', '/api/bookings', { token, org, body: booking('b4', 's2', 'p1', 'A', '18:00', '20:00') })).status, 201);
  // tuntematon myyjä
  assert.equal((await api('POST', '/api/bookings', { token, org, body: booking('b5', 'nobody', 'p1', 'B', '10:00', '12:00') })).status, 409);
  // virheellinen aika
  assert.equal((await api('POST', '/api/bookings', { token, org, body: booking('b6', 's2', 'p1', 'B', '25:00', '26:00') })).status, 400);
  // päivämäärärajaus
  assert.equal((await api('GET', '/api/bookings?from=2026-10-02', { token, org })).json.items.length, 0);
  assert.equal((await api('GET', '/api/bookings?from=2026-10-01&to=2026-10-01', { token, org })).json.items.length, 2);
});

test('poisto estetään, jos myyjään liittyy varauksia', async () => {
  const { admin: token, orgA: org } = ctx;
  const r = await api('DELETE', '/api/sellers/s1', { token, org });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'in_use');
  assert.equal((await api('DELETE', '/api/bookings/b4', { token, org })).status, 200);
});

test('monivuokraaja: toinen organisaatio ei näe eikä pääse toisen dataan', async () => {
  const cfg = loadConfig({ dbPath: ':memory:', jwtSecret: 'test-secret', allowRegistration: true });
  const { server: s2 } = createApp(cfg);
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const call = async (method, path, token, org, body) => {
    const res = await fetch(b2 + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(org ? { 'x-organization-id': org } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const a = (await call('POST', '/api/auth/register', null, null, { email: 'a@a.fi', name: 'A', password: 'salasana123', organization: 'A Oy' })).json;
  const b = (await call('POST', '/api/auth/register', null, null, { email: 'b@b.fi', name: 'B', password: 'salasana123', organization: 'B Oy' })).json;
  const orgA = a.memberships[0].orgId, orgB = b.memberships[0].orgId;
  await call('POST', '/api/sellers', a.token, orgA, seller('s1', 'Vain A:n'));
  assert.equal((await call('GET', '/api/sellers', b.token, orgB)).json.items.length, 0);
  assert.equal((await call('GET', '/api/sellers', b.token, orgA)).status, 403);
  assert.equal((await call('GET', '/api/sellers/s1', b.token, orgB)).status, 404);
  assert.equal((await call('DELETE', '/api/sellers/s1', b.token, orgA)).status, 403);
  // sama id voi olla eri organisaatioissa
  assert.equal((await call('POST', '/api/sellers', b.token, orgB, seller('s1', 'B:n oma'))).status, 201);
  assert.equal((await call('GET', '/api/sellers/s1', a.token, orgA)).json.name, 'Vain A:n');
  await new Promise((r) => s2.close(r));
});

test('roolit: jäsenen lisäys ja oikeuksien rajaus', async () => {
  const { admin: token, orgA: org } = ctx;
  const add = await api('POST', '/api/org/members', { token, org, body: { email: 'myyja@example.fi', name: 'Myyjä', password: 'salasana123', role: 'Myyjä' } });
  assert.equal(add.status, 201);
  const add2 = await api('POST', '/api/org/members', { token, org, body: { email: 'raportti@example.fi', name: 'Rapsa', password: 'salasana123', role: 'Raportointikäyttäjä' } });
  assert.equal(add2.status, 201);
  ctx.myyjaId = add.json.userId;
  assert.equal((await api('PATCH', `/api/org/members/${ctx.myyjaId}`, { token, org, body: { sellerId: 's1' } })).status, 200);
  ctx.myyja = (await api('POST', '/api/auth/login', { body: { email: 'myyja@example.fi', password: 'salasana123' } })).json.token;
  ctx.raportti = (await api('POST', '/api/auth/login', { body: { email: 'raportti@example.fi', password: 'salasana123' } })).json.token;
  assert.equal((await api('POST', '/api/sellers', { token: ctx.myyja, org, body: seller('s9', 'Ei saa') })).status, 403);
  assert.equal((await api('POST', '/api/bookings', { token: ctx.raportti, org, body: booking('b9', 's1', 'p1', 'B', '10:00', '11:00', '2026-11-01') })).status, 403);
  assert.equal((await api('GET', '/api/org/members', { token: ctx.myyja, org })).status, 403);
  // myyjä näkee omat tietonsa, mutta muiden yhteystiedot on tyhjennetty
  const list = await api('GET', '/api/sellers', { token: ctx.myyja, org });
  assert.equal(list.json.items.find((x) => x.id === 's1').phone, '050 999');
  assert.equal(list.json.items.find((x) => x.id === 's2').phone, '');
  assert.equal(list.json.items.find((x) => x.id === 's2').email, '');
  // viimeistä adminia ei voi poistaa tai alentaa
  const me = await api('GET', '/api/me', { token });
  const del = await api('DELETE', `/api/org/members/${me.json.user.id}`, { token, org });
  assert.equal(del.status, 409);
  assert.equal(del.json.error.code, 'last_admin');
});

test('records: CRM-kohteiden luonti ja roolirajaus', async () => {
  const { admin: token, orgA: org } = ctx;
  const r = await api('POST', '/api/records/leads', { token, org, body: { id: 'l1', name: 'Tripla', status: 'neuvottelu' } });
  assert.equal(r.status, 201);
  assert.equal((await api('GET', '/api/records/leads', { token, org })).json.items.length, 1);
  assert.equal((await api('GET', '/api/records/leads', { token: ctx.myyja, org })).status, 403);
  assert.equal((await api('POST', '/api/records/leads', { token: ctx.myyja, org, body: { name: 'x' } })).status, 403);
  assert.equal((await api('GET', '/api/records/tuntematon', { token, org })).status, 404);
});

test('työtila: kierros GET → PUT → GET säilyttää datan ja järjestyksen', async () => {
  const { admin: token, orgA: org } = ctx;
  const ws = await api('GET', '/api/workspace', { token, org });
  assert.equal(ws.status, 200);
  const state = ws.json.state;
  assert.equal(state.sellers.length, 2);
  state.sellers.push(seller('s3', 'Cecilia'));
  state.notifications = [{ id: 'n2', text: 'toinen' }, { id: 'n1', text: 'ensimmäinen' }];
  state.settings.labourCostH = 25;
  state.audit = [{ id: 'a1', action: 'testi' }];
  const put = await api('PUT', '/api/workspace', { token, org, body: { baseRev: ws.json.rev, state } });
  assert.equal(put.status, 200);
  assert.equal(put.json.rev, ws.json.rev + 1);
  const again = await api('GET', '/api/workspace', { token, org });
  assert.equal(again.json.state.sellers.length, 3);
  assert.deepEqual(again.json.state.notifications.map((n) => n.id), ['n2', 'n1']);
  assert.equal(again.json.state.settings.labourCostH, 25);
});

test('työtila: vanhentunut versio (rev) hylätään', async () => {
  const { admin: token, orgA: org } = ctx;
  const ws = await api('GET', '/api/workspace', { token, org });
  const stale = await api('PUT', '/api/workspace', { token, org, body: { baseRev: ws.json.rev - 1, state: ws.json.state } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'rev_mismatch');
});

test('työtila: päällekkäinen varaus hylätään ja muutokset perutaan', async () => {
  const { admin: token, orgA: org } = ctx;
  const ws = await api('GET', '/api/workspace', { token, org });
  const state = ws.json.state;
  state.sellers = state.sellers.filter((s) => s.id !== 's3');
  state.bookings.push(booking('bx', 's1', 'p1', 'B', '11:00', '12:00'));
  const put = await api('PUT', '/api/workspace', { token, org, body: { baseRev: ws.json.rev, state } });
  assert.equal(put.status, 409);
  assert.equal(put.json.error.code, 'booking_conflict');
  const after = await api('GET', '/api/workspace', { token, org });
  assert.equal(after.json.rev, ws.json.rev);
  assert.equal(after.json.state.sellers.length, 3);
});

test('työtila: myyjä voi kirjata omia kauppojaan mutta ei muokata myyjiä, eikä koko työtilaa voi korvata', async () => {
  const org = ctx.orgA;
  const ws = await api('GET', '/api/workspace', { token: ctx.myyja, org });
  const b1 = ws.json.state.bookings.find((b) => b.id === 'b1');
  const sellers = ws.json.state.sellers;
  // koko työtilan korvaus on vain Adminille
  assert.equal((await api('PUT', '/api/workspace', { token: ctx.myyja, org, body: { baseRev: ws.json.rev, state: ws.json.state } })).status, 403);
  const r = await doSync(ctx.myyja, org, {
    bookings: [[{ ...b1, deals: 5 }, b1]],
    time: [[{ id: 't1', sellerId: 's1', date: '2026-10-01', startTs: 1, endTs: null, breaks: [] }, null]],
    sellers: [[{ ...sellers[0], name: 'Kaapattu' }, sellers[0]]],
    audit: [[{ id: 'myyja-yritys' }, null]],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rejected.map((x) => x.kind + ':' + x.reason).sort(), ['audit:forbidden', 'sellers:forbidden']);
  const admin = await api('GET', '/api/workspace', { token: ctx.admin, org });
  assert.equal(admin.json.state.sellers.length, 3);
  assert.notEqual(admin.json.state.sellers[0].name, 'Kaapattu');
  assert.equal(admin.json.state.bookings[0].deals, 5);
  assert.equal(admin.json.state.time.length, 1);
  assert.deepEqual(admin.json.state.audit.map((a) => a.id), ['a1']); // myyjän yritys ei ylikirjoita historiaa
  assert.equal((await api('PUT', '/api/workspace', { token: ctx.raportti, org, body: { baseRev: admin.json.rev, state: admin.json.state } })).status, 403);
  assert.equal((await doSync(ctx.raportti, org, { needs: [[{ id: 'n-r' }, null]] })).status, 403);
});

test('muutosloki tallentaa kirjoitukset', async () => {
  const r = await api('GET', '/api/audit', { token: ctx.admin, org: ctx.orgA });
  assert.equal(r.status, 200);
  assert.ok(r.json.items.some((a) => a.action === 'bookings.create'));
  assert.ok(r.json.items.some((a) => a.action === 'workspace.sync'));
  assert.equal((await api('GET', '/api/audit', { token: ctx.myyja, org: ctx.orgA })).status, 403);
});

test('liian suuri pyyntö hylätään', async () => {
  const cfg = loadConfig({ dbPath: ':memory:', jwtSecret: 's', bodyLimit: 1000 });
  const { server: s2 } = createApp(cfg);
  await new Promise((r) => s2.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(2000) }) });
  assert.equal(res.status, 413);
  await new Promise((r) => s2.close(r));
});

test('linkitys: virheelliset linkitykset hylätään ja kirjautumisessa näkyy sellerId', async () => {
  const { admin: token, orgA: org } = ctx;
  assert.equal((await api('PATCH', `/api/org/members/${ctx.myyjaId}`, { token, org, body: { sellerId: 'ei-ole' } })).status, 404);
  const raportti = (await api('GET', '/api/org/members', { token, org })).json.items.find((m) => m.email === 'raportti@example.fi');
  const taken = await api('PATCH', `/api/org/members/${raportti.userId}`, { token, org, body: { sellerId: 's1' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error.code, 'seller_taken');
  assert.equal((await api('PATCH', `/api/org/members/${ctx.myyjaId}`, { token, org, body: {} })).status, 400);
  const me = await api('GET', '/api/me', { token: ctx.myyja });
  assert.equal(me.json.memberships[0].sellerId, 's1');
  const ws = await api('GET', '/api/workspace', { token: ctx.myyja, org });
  assert.equal(ws.json.sellerId, 's1');
});

test('myyjä näkee muiden varauksista vain perustiedot ja vain omat aikamerkinnät', async () => {
  const { admin: token, orgA: org } = ctx;
  const b7 = { ...booking('b7', 's2', 'p1', 'B', '10:00', '12:00', '2026-10-02'), deals: 9, note: 'salainen' };
  assert.equal((await api('POST', '/api/bookings', { token, org, body: b7 })).status, 201);
  await api('POST', '/api/records/time', { token, org, body: { id: 't-other', sellerId: 's2', date: '2026-10-02', startTs: 5, endTs: null, breaks: [] } });
  const ws = await api('GET', '/api/workspace', { token: ctx.myyja, org });
  const other = ws.json.state.bookings.find((b) => b.id === 'b7');
  assert.equal(other.deals, undefined);
  assert.equal(other.note, undefined);
  assert.equal(other.sellerId, 's2');
  assert.equal(ws.json.state.bookings.find((b) => b.id === 'b1').deals, 5);
  assert.ok(ws.json.state.time.every((t) => t.sellerId === 's1'));
});

test('myyjä ei voi muokata toisen myyjän vuoroa, aikamerkintöjä tai poikkeamia', async () => {
  const { admin: token, orgA: org } = ctx;
  await api('POST', '/api/records/incidents', { token, org, body: { id: 'i-other', title: 'Toisen poikkeama', sellerId: 's2', status: 'uusi' } });
  const ws = await api('GET', '/api/workspace', { token: ctx.myyja, org });
  const st = ws.json.state;
  const b1 = st.bookings.find((b) => b.id === 'b1');
  const b7 = st.bookings.find((b) => b.id === 'b7');
  const iOther = st.incidents.find((i) => i.id === 'i-other');
  const r = await doSync(ctx.myyja, org, {
    bookings: [[{ ...b7, deals: 99 }, b7], [{ ...b1, deals: 7 }, b1]],         // toisen vuoro: ei; oma: kyllä
    time: [[{ id: 't-fake', sellerId: 's2', date: '2026-10-02', startTs: 1, endTs: null, breaks: [] }, null],
           [{ id: 't-own2', sellerId: 's1', date: '2026-10-03', startTs: 1, endTs: null, breaks: [] }, null]],
    incidents: [[{ id: 'i-own', title: 'Oma', sellerId: 's1', status: 'uusi' }, null],
                [{ id: 'i-fake', title: 'Väärennös', sellerId: 's2', status: 'uusi' }, null],
                [{ ...iOther, status: 'ratkaistu' }, iOther]],                   // toisen poikkeaman muutos: ei
  }, { incidents: [['i-other', iOther]] });                                      // toisen poikkeaman poisto: ei
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rejected.map((x) => `${x.kind}:${x.id}:${x.reason}`).sort(),
    ['bookings:b7:forbidden', 'incidents:i-fake:forbidden', 'incidents:i-other:forbidden', 'incidents:i-other:forbidden', 'time:t-fake:forbidden'].sort());
  const a = (await api('GET', '/api/workspace', { token, org })).json.state;
  assert.equal(a.bookings.find((b) => b.id === 'b7').deals, 9);
  assert.equal(a.bookings.find((b) => b.id === 'b1').deals, 7);
  assert.ok(a.time.some((t) => t.id === 't-own2'));
  assert.ok(!a.time.some((t) => t.id === 't-fake'));
  assert.equal(a.incidents.find((i) => i.id === 'i-other').status, 'uusi');
  assert.ok(a.incidents.some((i) => i.id === 'i-own'));
  assert.ok(!a.incidents.some((i) => i.id === 'i-fake'));
});

test('myyjän REST-kirjoitukset rajataan omiin tietoihin eikä poistoja sallita', async () => {
  const org = ctx.orgA;
  assert.equal((await api('POST', '/api/records/time', { token: ctx.myyja, org, body: { id: 't-rest-other', sellerId: 's2' } })).status, 403);
  assert.equal((await api('POST', '/api/records/time', { token: ctx.myyja, org, body: { id: 't-rest-own', sellerId: 's1' } })).status, 201);
  assert.equal((await api('DELETE', '/api/records/time/t-rest-own', { token: ctx.myyja, org })).status, 403);
  assert.equal((await api('PATCH', '/api/records/incidents/i-other', { token: ctx.myyja, org, body: { status: 'ratkaistu' } })).status, 403);
  // ilmoituksiin vain lisäys
  assert.equal((await api('POST', '/api/records/notifications', { token: ctx.myyja, org, body: { id: 'n-new', text: 'uusi' } })).status, 201);
  assert.equal((await api('PATCH', '/api/records/notifications/n-new', { token: ctx.myyja, org, body: { text: 'muutettu' } })).status, 403);
  // vuoronvaihtoa ei voi vahvistaa myyjänä
  assert.equal((await api('POST', '/api/records/swaps', { token: ctx.myyja, org, body: { id: 'w-x', from: 's1', to: 's2', status: 'vahvistettu' } })).status, 403);
  assert.equal((await api('POST', '/api/records/swaps', { token: ctx.myyja, org, body: { id: 'w-ok', from: 's1', to: 's2', status: 'pyydetty' } })).status, 201);
});

test('linkittämätön myyjä-tili ei voi kirjoittaa tuloksia', async () => {
  const { admin: token, orgA: org } = ctx;
  await api('POST', '/api/org/members', { token, org, body: { email: 'linkitta@example.fi', name: 'Linkittämätön', password: 'salasana123', role: 'Myyjä' } });
  const t = (await api('POST', '/api/auth/login', { body: { email: 'linkitta@example.fi', password: 'salasana123' } })).json.token;
  const ws = await api('GET', '/api/workspace', { token: t, org });
  assert.equal(ws.json.sellerId, null);
  const b1 = ws.json.state.bookings.find((b) => b.id === 'b1');
  const r = await doSync(t, org, { bookings: [[{ ...b1, deals: 123 }, b1]] });
  assert.equal(r.json.rejected[0].reason, 'forbidden');
  const a = (await api('GET', '/api/workspace', { token, org })).json.state;
  assert.notEqual(a.bookings.find((b) => b.id === 'b1').deals, 123);
  assert.equal((await api('POST', '/api/records/time', { token: t, org, body: { id: 't-no', sellerId: 's1' } })).status, 403);
});

test('myyjän poisto purkaa käyttäjälinkityksen', async () => {
  const { admin: token, orgA: org } = ctx;
  await api('POST', '/api/sellers', { token, org, body: seller('s5', 'Poistettava') });
  const raportti = (await api('GET', '/api/org/members', { token, org })).json.items.find((m) => m.email === 'raportti@example.fi');
  assert.equal((await api('PATCH', `/api/org/members/${raportti.userId}`, { token, org, body: { sellerId: 's5' } })).status, 200);
  assert.equal((await api('DELETE', '/api/sellers/s5', { token, org })).status, 200);
  const after = (await api('GET', '/api/org/members', { token, org })).json.items.find((m) => m.email === 'raportti@example.fi');
  assert.equal(after.sellerId, null);
});

test('jäsenen lisäys voi linkittää myyjäprofiiliin heti', async () => {
  const { admin: token, orgA: org } = ctx;
  await api('POST', '/api/sellers', { token, org, body: seller('s6', 'Linkitettävä') });
  const add = await api('POST', '/api/org/members', { token, org, body: { email: 'suoraan@example.fi', name: 'Suoraan', password: 'salasana123', role: 'Myyjä', sellerId: 's6' } });
  assert.equal(add.status, 201);
  assert.equal(add.json.sellerId, 's6');
  const dup = await api('POST', '/api/org/members', { token, org, body: { email: 'kaksi@example.fi', name: 'Kaksi', password: 'salasana123', role: 'Myyjä', sellerId: 's6' } });
  assert.equal(dup.status, 409);
});

/* ---------- Inkrementaalinen synkronointi ---------- */
test('sync: tietueen lisäys, muutos ja poisto sormenjäljen (base) avulla', async () => {
  const { admin: token, orgA: org } = ctx;
  const camp1 = { id: 'k1', name: 'Syyskampanja', target: 100 };
  const r1 = await doSync(token, org, { campaigns: [[camp1, null]] });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json.rejected, []);
  assert.equal(r1.json.applied.campaigns.k1, H(camp1));
  // muutos oikealla basella
  const camp2 = { ...camp1, target: 200 };
  const r2 = await doSync(token, org, { campaigns: [[camp2, camp1]] });
  assert.equal(r2.json.applied.campaigns.k1, H(camp2));
  // vanhentunut base hylätään ja palvelimen versio palautetaan
  const r3 = await doSync(token, org, { campaigns: [[{ ...camp1, target: 300 }, camp1]] });
  assert.equal(r3.json.rejected[0].reason, 'conflict');
  assert.equal(r3.json.rejected[0].server.target, 200);
  // poisto vanhalla basella hylätään, oikealla onnistuu
  assert.equal((await doSync(token, org, {}, { campaigns: [['k1', camp1]] })).json.rejected[0].reason, 'conflict');
  const r5 = await doSync(token, org, {}, { campaigns: [['k1', camp2]] });
  assert.deepEqual(r5.json.rejected, []);
  assert.equal(r5.json.applied.campaigns.k1, null);
  // jo poistetun poisto on ok, poistetun muokkaus ilmoitetaan
  assert.deepEqual((await doSync(token, org, {}, { campaigns: [['k1', camp2]] })).json.rejected, []);
  assert.equal((await doSync(token, org, { campaigns: [[camp2, camp2]] })).json.rejected[0].reason, 'deleted_by_other');
});

test('sync: yksi ristiriitainen varaus hylätään, muut saman pyynnön muutokset menevät läpi', async () => {
  const { admin: token, orgA: org } = ctx;
  const good = { id: 'k-good', name: 'Hyvä' };
  const badB = booking('b-clash', 's1', 'p1', 'B', '11:00', '12:00', '2026-10-01'); // s1 on jo varattu b1:ssä
  const okB = booking('b-ok', 's2', 'p1', 'B', '13:00', '15:00', '2026-10-05');
  const r = await doSync(token, org, { campaigns: [[good, null]], bookings: [[badB, null], [okB, null]] });
  assert.equal(r.status, 200);
  assert.equal(r.json.rejected.length, 1);
  assert.equal(r.json.rejected[0].id, 'b-clash');
  assert.equal(r.json.rejected[0].reason, 'booking_conflict');
  assert.equal(r.json.rejected[0].conflicts[0].code, 'seller');
  assert.ok(r.json.applied.bookings['b-ok']);
  assert.ok(r.json.applied.campaigns['k-good']);
});

test('sync: rev nousee vain kun jotain muuttui, ja stale-lippu kertoo muiden muutoksista', async () => {
  const { admin: token, orgA: org } = ctx;
  const ws = await api('GET', '/api/workspace', { token, org });
  const rev0 = ws.json.rev;
  const nothing = await api('POST', '/api/sync', { token, org, body: { baseRev: rev0, changes: {} } });
  assert.equal(nothing.json.rev, rev0);
  assert.equal(nothing.json.stale, false);
  const n1 = { id: 'nn1', text: 'x' };
  const a = await api('POST', '/api/sync', { token, org, body: { baseRev: rev0, ...syncBody({ needs: [[n1, null]] }) } });
  assert.equal(a.json.rev, rev0 + 1);
  assert.equal(a.json.stale, false);
  // toinen kirjoittaa välissä (REST nostaa revin), sitten vanhalla revillä lähettävä saa stale=true
  await api('POST', '/api/records/needs', { token, org, body: { id: 'nn2', text: 'y' } });
  const b = await api('POST', '/api/sync', { token, org, body: { baseRev: rev0 + 1, ...syncBody({ needs: [[{ ...n1, text: 'z' }, n1]] }) } });
  assert.equal(b.json.stale, true);
  assert.deepEqual(b.json.rejected, []);
  // kevyt pollaus
  const cur = (await api('GET', '/api/workspace', { token, org })).json.rev;
  const same = await api('GET', `/api/workspace?since=${cur}`, { token, org });
  assert.equal(same.json.unchanged, true);
  assert.equal(same.json.state, undefined);
  const older = await api('GET', `/api/workspace?since=${cur - 1}`, { token, org });
  assert.ok(older.json.state);
});

test('sync: uusimmat ilmoitukset menevät listan alkuun, muut loppuun', async () => {
  const { admin: token, orgA: org } = ctx;
  await doSync(token, org, { notifications: [[{ id: 'not-1', text: 'ensin' }, null]] });
  await doSync(token, org, { notifications: [[{ id: 'not-2', text: 'sitten' }, null]] });
  const st = (await api('GET', '/api/workspace', { token, org })).json.state;
  const ids = st.notifications.map((n) => n.id);
  assert.ok(ids.indexOf('not-2') < ids.indexOf('not-1'));
  const needs = st.needs.map((n) => n.id);
  assert.ok(needs.indexOf('nn1') < needs.indexOf('nn2'));
});

test('sync: asetukset vain Adminille ja versiotarkistuksella', async () => {
  const { admin: token, orgA: org } = ctx;
  const cur = (await api('GET', '/api/workspace', { token, org })).json.state.settings;
  const ok = await api('POST', '/api/sync', { token, org, body: { changes: {}, settings: { base: H(cur), value: { ...cur, targetPerShift: 9 } } } });
  assert.equal(ok.json.settings.targetPerShift, 9);
  const stale = await api('POST', '/api/sync', { token, org, body: { changes: {}, settings: { base: H(cur), value: { ...cur, targetPerShift: 12 } } } });
  assert.equal(stale.json.rejected[0].reason, 'conflict');
  assert.equal(stale.json.rejected[0].server.targetPerShift, 9);
  const esihenkilo = (await api('POST', '/api/org/members', { token, org, body: { email: 'esihenkilo@example.fi', name: 'Esi', password: 'salasana123', role: 'Esihenkilö' } }));
  assert.equal(esihenkilo.status, 201);
  const t = (await api('POST', '/api/auth/login', { body: { email: 'esihenkilo@example.fi', password: 'salasana123' } })).json.token;
  const now = (await api('GET', '/api/workspace', { token: t, org })).json.state.settings;
  const denied = await api('POST', '/api/sync', { token: t, org, body: { changes: {}, settings: { base: H(now), value: { ...now, targetPerShift: 1 } } } });
  assert.equal(denied.json.rejected[0].reason, 'forbidden');
  // Esihenkilö ei voi korvata koko työtilaa
  assert.equal((await api('PUT', '/api/workspace', { token: t, org, body: { baseRev: 0, state: {} } })).status, 403);
});

test('sync: roolin oikeudet pakotetaan tietueittain (Buukkaaja ei muokkaa myyjiä)', async () => {
  const { admin: token, orgA: org } = ctx;
  await api('POST', '/api/org/members', { token, org, body: { email: 'buukkaaja@example.fi', name: 'Buukkaaja', password: 'salasana123', role: 'Buukkaaja' } });
  const t = (await api('POST', '/api/auth/login', { body: { email: 'buukkaaja@example.fi', password: 'salasana123' } })).json.token;
  const st = (await api('GET', '/api/workspace', { token: t, org })).json.state;
  const s1 = st.sellers.find((s) => s.id === 's1');
  const lead = { id: 'lead-b', name: 'Buukkaajan kohde', status: 'uusi' };
  const r = await doSync(t, org, { sellers: [[{ ...s1, name: 'Väärin' }, s1]], leads: [[lead, null]] });
  assert.deepEqual(r.json.rejected.map((x) => `${x.kind}:${x.reason}`), ['sellers:forbidden']);
  assert.ok(r.json.applied.leads['lead-b']);
  assert.equal((await api('GET', '/api/sellers/s1', { token, org })).json.name, 'Anna');
});

test('sync: virheellinen syöte hylätään', async () => {
  const { admin: token, orgA: org } = ctx;
  assert.equal((await api('POST', '/api/sync', { token, org, body: { changes: { tuntematon: { upsert: [] } } } })).status, 400);
  assert.equal((await api('POST', '/api/sync', { token, org, body: { changes: { needs: { upsert: [{ item: { name: 'ei id:tä' }, base: null }] } } } })).status, 400);
  assert.equal((await api('POST', '/api/sync', { token, org, body: { changes: { bookings: { upsert: [{ item: { id: 'bx', date: 'ei-päivä' }, base: null }] } } } })).status, 400);
});

/* ---------- Useita myyjiä samalla ständipaikalla (1–4) ---------- */
test('ständin kapasiteetti: samalla ständillä voi olla useita myyjiä kapasiteettiin asti', async () => {
  const { admin: token, orgA: org } = ctx;
  const p = { id: 'p-kap', name: 'Kapasiteettikeskus', city: 'Oulu', region: 'Pohjois-Pohjanmaa', stands: [{ id: 'A', capacity: 2 }, { id: 'B' }] };
  assert.equal((await api('POST', '/api/places', { token, org, body: p })).status, 201);
  for (const id of ['s7', 's8', 's9', 's10', 's11']) assert.equal((await api('POST', '/api/sellers', { token, org, body: seller(id, 'Kap ' + id) })).status, 201);
  const D = '2027-01-10';
  const bk = (id, s, st, a, b) => api('POST', '/api/bookings', { token, org, body: booking(id, s, 'p-kap', st, a, b, D) });
  assert.equal((await bk('k1', 's7', 'A', '10:00', '14:00')).status, 201);
  assert.equal((await bk('k2', 's8', 'A', '10:00', '14:00')).status, 201);     // kapasiteetti 2 täynnä
  const full = await bk('k3', 's9', 'A', '11:00', '13:00');
  assert.equal(full.status, 409);
  assert.equal(full.json.error.details.conflicts[0].code, 'stand');
  assert.equal((await bk('k4', 's9', 'A', '14:00', '18:00')).status, 201);     // peräkkäin: ei päällekkäinen
  assert.equal((await bk('k5', 's10', 'A', '12:00', '16:00')).status, 409);    // 12–14 kolme yhtä aikaa
  assert.equal((await bk('k6', 's10', 'B', '12:00', '16:00')).status, 201);    // oletuskapasiteetti 4
  assert.equal((await bk('k7', 's11', 'B', '12:00', '16:00')).status, 201);
  // sama myyjä ei voi olla kahdessa paikassa yhtä aikaa vaikka ständissä olisi tilaa
  const dup = await bk('k8', 's7', 'B', '11:00', '12:00');
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.details.conflicts[0].code, 'seller');
});

test('ständin kapasiteetti: neljä myyjää mahtuu oletuksena, viides ei', async () => {
  const { admin: token, orgA: org } = ctx;
  const p = { id: 'p-nelja', name: 'Neljän paikka', city: 'Oulu', region: 'Pohjois-Pohjanmaa', stands: [{ id: 'A' }] };
  await api('POST', '/api/places', { token, org, body: p });
  const D = '2027-02-01';
  const ids = ['s7', 's8', 's9', 's10'];
  for (const [i, s] of ids.entries()) assert.equal((await api('POST', '/api/bookings', { token, org, body: booking('n' + i, s, 'p-nelja', 'A', '10:00', '18:00', D) })).status, 201);
  const fifth = await api('POST', '/api/bookings', { token, org, body: booking('n5', 's11', 'p-nelja', 'A', '10:00', '18:00', D) });
  assert.equal(fifth.status, 409);
  assert.equal(fifth.json.error.details.conflicts[0].code, 'stand');
  // synkronointikaan ei ohita rajaa
  const r = await doSync(token, org, { bookings: [[booking('n6', 's11', 'p-nelja', 'A', '10:00', '18:00', D), null]] });
  assert.equal(r.json.rejected[0].reason, 'booking_conflict');
});

test('ständin kapasiteetti: virheellinen arvo hylätään', async () => {
  const { admin: token, orgA: org } = ctx;
  for (const cap of [0, 5, 2.5, '3']) {
    const r = await api('POST', '/api/places', { token, org, body: { id: 'p-bad', name: 'Huono', stands: [{ id: 'A', capacity: cap }] } });
    assert.equal(r.status, 400);
  }
});

/* ---------- OpenStreetMap-paikat ---------- */
const SAMPLE = JSON.parse(fs.readFileSync(new URL('./osm-sample.json', import.meta.url), 'utf8'));

test('OSM: Overpass-vastaus muunnetaan paikoiksi ja virheelliset ohitetaan', () => {
  const items = parseOverpass(SAMPLE);
  assert.equal(items.length, 30);                                             // ei sijaintia -> pois, kahvila -> pois
  const byKind = {};
  for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  assert.deepEqual(byKind, { fuel: 11, supermarket: 10, mall: 3, department_store: 2, exhibition: 4 });
  const way = items.find((i) => i.name === 'Esimerkki Kauppakeskus Helsinki');
  assert.equal(way.id.startsWith('way/'), true);
  assert.equal(way.lat, 60.19);                                               // suuntaa-antava keskipiste (center)
  const fuel = items.find((i) => i.name === 'Esimerkki Huoltoasema Helsinki');
  assert.equal(fuel.address.startsWith('Testikatu '), true);
  assert.equal(fuel.hours, '24/7');
  assert.ok(items.some((i) => i.name === 'Vain Merkki'));                     // nimi puuttuu -> brand
  assert.ok(!items.some((i) => i.name === 'Ei sijaintia' || i.name === 'Kahvila'));
});

test('OSM: tuonti, tilastot, aluehaku ja lähialuehaku', async () => {
  const { admin: token, orgA: org } = ctx;
  assert.equal(replacePois(mainDb, parseOverpass(SAMPLE)), 30);
  assert.equal(replacePois(mainDb, parseOverpass(SAMPLE)), 30);              // uusi tuonti korvaa, ei tuplaa
  const st = await api('GET', '/api/pois/stats', { token, org });
  assert.equal(st.json.total, 30);
  assert.equal(st.json.byKind.exhibition, 4);
  assert.ok(st.json.importedAt);
  // aluehaku: Helsinki–Espoo
  const bbox = await api('GET', '/api/pois?bbox=24.4,60.0,25.2,60.4&kinds=fuel,mall', { token, org });
  assert.equal(bbox.status, 200);
  assert.deepEqual([...new Set(bbox.json.items.map((i) => i.kind))].sort(), ['fuel', 'mall']);
  assert.ok(bbox.json.items.every((i) => i.lat >= 60.0 && i.lat <= 60.4));
  assert.equal(bbox.json.attribution.includes('OpenStreetMap'), true);
  const q = await api('GET', '/api/pois?bbox=19,59,32,70&q=Tampere', { token, org });
  assert.ok(q.json.items.length >= 3 && q.json.items.every((i) => (i.name + i.city).includes('Tampere')));
  // lähialue: 30 km Helsingin keskustasta, lähin ensin
  const near = await api('GET', '/api/pois/near?lat=60.17&lon=24.94&km=30&kinds=fuel,supermarket,mall,exhibition', { token, org });
  const d = near.json.items.map((i) => i.distanceKm);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.ok(d.every((x) => x <= 30));
  assert.ok(near.json.items.some((i) => i.city === 'Espoo'));
  assert.ok(!near.json.items.some((i) => i.city === 'Tampere'));
  assert.equal((await api('GET', '/api/pois/near?lat=60.17&lon=24.94&km=1', { token, org })).json.items.length, 0);
  // virheellinen syöte
  assert.equal((await api('GET', '/api/pois?bbox=ei,ole,laatikko,x', { token, org })).status, 400);
  assert.equal((await api('GET', '/api/pois/near?lat=60&lon=24&km=9999', { token, org })).status, 400);
  assert.equal((await api('GET', '/api/pois/near?lon=24', { token, org })).status, 400);
});

test('OSM: paikat ovat vain buukkarin työkaluja (myyjä ei näe)', async () => {
  const org = ctx.orgA;
  assert.equal((await api('GET', '/api/pois/stats', { token: ctx.myyja, org })).status, 403);
  assert.equal((await api('GET', '/api/pois/near?lat=60&lon=24&km=10', { token: ctx.myyja, org })).status, 403);
  assert.equal((await api('GET', '/api/pois/stats')).status, 401);
});

test('osoitehaku: palvelin hakee koordinaatit, rajoitukset ja virheet', async () => {
  const { admin: token, orgA: org } = ctx;
  const ok = await api('POST', '/api/geocode', { token, org, body: { q: 'Testikatu 1, Tampere' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.lat, 61.49775);
  assert.equal(ok.json.lon, 23.76095);
  assert.equal((await api('POST', '/api/geocode', { token, org, body: { q: 'Tuntematon 99, Ei Missään' } })).status, 404);
  assert.equal((await api('POST', '/api/geocode', { token, org, body: { q: 'ab' } })).status, 400);
  assert.equal((await api('POST', '/api/geocode', { token: ctx.myyja, org, body: { q: 'Testikatu 1' } })).status, 403);
  // pois kytketty palvelin
  const { server: s2 } = createApp(loadConfig({ dbPath: ':memory:', jwtSecret: 's', allowRegistration: true, geocoderUrl: 'off' }));
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const reg = await (await fetch(b2 + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'g@g.fi', name: 'G', password: 'salasana123', organization: 'G Oy' }) })).json();
  const r = await fetch(b2 + '/api/geocode', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ q: 'Testikatu 1' }) });
  assert.equal(r.status, 503);
  await new Promise((r2) => s2.close(r2));
});

test('myyjän kotiosoite ja työskentelysäde: validointi ja näkyvyys vain buukkarille', async () => {
  const { admin: token, orgA: org } = ctx;
  const home = { address: 'Testikatu 1, Tampere', lat: 61.49775, lon: 23.76095, city: 'Tampere', source: 'geocode' };
  const s = { ...seller('s-koti', 'Koti Myyjä'), home, radiusKm: 80 };
  assert.equal((await api('POST', '/api/sellers', { token, org, body: s })).status, 201);
  // validointi
  assert.equal((await api('POST', '/api/sellers', { token, org, body: { ...seller('s-bad1', 'X'), home: { lat: 200, lon: 10 } } })).status, 400);
  assert.equal((await api('POST', '/api/sellers', { token, org, body: { ...seller('s-bad2', 'X'), radiusKm: 0 } })).status, 400);
  assert.equal((await api('POST', '/api/sellers', { token, org, body: { ...seller('s-bad3', 'X'), home: 'kotona' } })).status, 400);
  // Admin näkee, myyjä ja raportointi eivät
  const a = (await api('GET', '/api/sellers/s-koti', { token, org })).json;
  assert.equal(a.home.address, 'Testikatu 1, Tampere');
  assert.equal(a.radiusKm, 80);
  for (const t of [ctx.myyja, ctx.raportti]) {
    const list = (await api('GET', '/api/sellers', { token: t, org })).json.items.find((x) => x.id === 's-koti');
    assert.equal(list.home, undefined);
    assert.equal(list.radiusKm, undefined);
    const ws = (await api('GET', '/api/workspace', { token: t, org })).json.state.sellers.find((x) => x.id === 's-koti');
    assert.equal(ws.home, undefined);
    assert.equal(ws.radiusKm, undefined);
  }
  // synkronointi säilyttää kotiosoitteen
  const adminState = (await api('GET', '/api/workspace', { token, org })).json.state.sellers.find((x) => x.id === 's-koti');
  const r = await doSync(token, org, { sellers: [[{ ...adminState, radiusKm: 120 }, adminState]] });
  assert.deepEqual(r.json.rejected, []);
  assert.equal((await api('GET', '/api/sellers/s-koti', { token, org })).json.home.city, 'Tampere');
});

/* ---------- Valokuvatuonti (tekoäly, API-avain valmiudessa) ---------- */
test('valokuvatuonti: ilman API-avainta palauttaa selkeän 501-vastauksen', async () => {
  const { admin: token, orgA: org } = ctx;
  const r = await api('POST', '/api/import/photo', { token, org, body: { target: 'leads', mediaType: 'image/jpeg', image: 'aGVsbG8=' } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'ai_not_configured');
  assert.equal((await api('POST', '/api/import/photo', { token: ctx.myyja, org, body: { target: 'leads', mediaType: 'image/jpeg', image: 'aGVsbG8=' } })).status, 403);
});

test('valokuvatuonti: avaimella toimii esikuvapalvelinta vasten, tulokset siivotaan', async () => {
  const captured = [];
  const aiStub = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    captured.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: '```json\n[{"name":"Maria Virtanen","city":"Tampere","contactName":"Maria","phone":"040 1","email":"m@x.fi","notes":"","extra":"<script>x</script>"},{"city":"Ei nimeä"}]\n```' }] }));
  });
  await new Promise((r) => aiStub.listen(0, r));
  const cfg = loadConfig({ dbPath: ':memory:', jwtSecret: 's2', allowRegistration: true, aiApiKey: 'test-key', aiApiUrl: `http://127.0.0.1:${aiStub.address().port}/v1/messages` });
  const { server: s2 } = createApp(cfg);
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const reg = await (await fetch(b2 + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ai@ai.fi', name: 'AI', password: 'salasana123', organization: 'AI Oy' }) })).json();
  const r = await fetch(b2 + '/api/import/photo', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}`, 'x-organization-id': reg.memberships[0].orgId }, body: JSON.stringify({ target: 'leads', mediaType: 'image/jpeg', image: 'aGVsbG8=' }) });
  const json = await r.json();
  assert.equal(r.status, 200);
  assert.equal(json.items.length, 1);                                        // toinen alkio ohitetaan (nimi puuttuu)
  assert.equal(json.items[0].name, 'Maria Virtanen');
  assert.equal(json.items[0].extra, undefined);                              // vain sallitut kentät palautetaan
  assert.equal(captured[0].headers['x-api-key'], 'test-key');
  assert.equal(captured[0].body.messages[0].content[0].source.data, 'aGVsbG8=');
  await new Promise((r2) => s2.close(r2));
  await new Promise((r2) => aiStub.close(r2));
});

test('valokuvatuonti: virheellinen syöte ja liian suuri kuva hylätään', async () => {
  const { admin: token, orgA: org } = ctx;
  const cfg = loadConfig({ dbPath: ':memory:', jwtSecret: 's3', allowRegistration: true, aiApiKey: 'k' });
  const { server: s2 } = createApp(cfg);
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const reg = await (await fetch(b2 + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'big@ai.fi', name: 'B', password: 'salasana123', organization: 'B Oy' }) })).json();
  const call = (body) => fetch(b2 + '/api/import/photo', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}`, 'x-organization-id': reg.memberships[0].orgId }, body: JSON.stringify(body) });
  assert.equal((await call({ target: 'muu', mediaType: 'image/jpeg', image: 'aGVsbG8=' })).status, 400);
  assert.equal((await call({ target: 'leads', mediaType: 'application/pdf', image: 'aGVsbG8=' })).status, 400);
  assert.equal((await call({ target: 'leads', mediaType: 'image/jpeg', image: 'ei-base64!' })).status, 400);
  assert.equal((await call({ target: 'leads', mediaType: 'image/jpeg', image: 'A'.repeat(11 * 1024 * 1024) })).status, 413);
  await new Promise((r2) => s2.close(r2));
});
