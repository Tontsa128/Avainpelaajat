// Käyttöliittymän logiikan testit: ladataan toimitettava index.html ja ajetaan sen sisältämä
// viikkosuunnittelija, etäisyyslaskenta ja kapasiteettisäännöt ilman selainta.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let code = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('\n</script>'));
code = code.replace(/^\(function\(\)\{\n?/, '').replace(/\n\}\)\(\);\s*$/, '').replace(/persist\(\);\nrender\(\);\nbootSync\(\);\s*$/, '');
const EXPORTS = `return {
  get S() { return S; }, set S(v) { S = v; }, seedData, emptyData, planWeek, acceptBlocks, haversine, standCap, peakLoad, conflicts,
  T, addISO, startOfWeek, sRadius, hasHome, tmin, rangeData, poisNear, poisBbox, demoPois, nearestCity, absenceOn, seller, place, freeStandFor, parseCSV, parseVCard, validEmail, validPhone };`;

function load() {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const doc = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
  const win = { addEventListener() {}, scrollTo() {}, innerWidth: 400, scrollY: 0 };
  return new Function('document', 'window', 'localStorage', 'fetch', 'setInterval', 'navigator', 'location', code + '\n' + EXPORTS)(
    doc, win, localStorage, async () => { throw new Error('ei verkkoa'); }, () => 0, {}, { hostname: 'localhost' });
}

const A = load();
const nextWeek = () => A.addISO(A.startOfWeek(A.T()), 7);
const plan = (o = {}) => A.planWeek({ weekStart: nextWeek(), ...o });
const DAY = (n) => A.addISO(nextWeek(), n);

test('etäisyys: haversine ja lähin kaupunki', () => {
  const hki = { lat: 60.17, lon: 24.94 }, tre = { lat: 61.5, lon: 23.76 };
  const d = A.haversine(hki, tre);
  assert.ok(d > 155 && d < 165, `Helsinki–Tampere ~161 km, oli ${d}`);
  assert.equal(A.nearestCity(60.21, 24.9), 'Helsinki');
  assert.equal(A.nearestCity(70.0, 20.0), '');                                 // yli 60 km lähimmästä
});

test('ständin kapasiteetti: peräkkäiset vuorot eivät ole päällekkäisiä', () => {
  assert.equal(A.peakLoad([[600, 840], [840, 1080]]), 1);
  assert.equal(A.peakLoad([[600, 840], [600, 840], [720, 960]]), 3);
  assert.equal(A.peakLoad([]), 0);
});

test('demoaineisto: myyjillä on kotiosoite ja säde, kohteilla ständikapasiteetti', () => {
  assert.ok(A.S.sellers.every((s) => A.hasHome(s) && A.sRadius(s) >= 60));
  assert.ok(A.S.places.every((p) => p.stands.every((s) => A.standCap(p, s.id) === 4)));
});

test('suunnittelija: ehdotukset ovat piirissä, sopimusaikana ja vapaina päivinä', () => {
  const r = plan();
  assert.ok(r.blocks.length > 0, 'ehdotuksia pitää syntyä');
  for (const b of r.blocks) {
    const s = A.seller(b.sellerId), p = A.place(b.placeId);
    assert.ok(b.dates.length >= 1 && b.dates.length <= 2);
    if (b.dates.length === 2) assert.equal(A.addISO(b.dates[0], 1), b.dates[1]);      // jakso on peräkkäisiä päiviä
    assert.ok(A.haversine(s.home, p) <= A.sRadius(s) + 0.5, `${s.name} → ${p.name} ylittää piirin`);
    for (const d of b.dates) {
      assert.ok(d >= p.contract.start && d <= p.contract.end, 'sopimuksen ulkopuolella');
      const wd = (new Date(d + 'T00:00:00').getDay() + 6) % 7;
      assert.ok(wd <= 4, 'vain ma–pe oletuksena');
      assert.ok(!A.absenceOn(s, d), 'myyjällä on poissaolo');
    }
  }
});

test('suunnittelija: kukaan ei ole kahdessa paikassa yhtä aikaa eikä ständi ylitä kapasiteettia', () => {
  const r = plan();
  const all = A.S.bookings.map((b) => ({ ...b }));
  for (const b of r.blocks) b.dates.forEach((d, i) => all.push({ date: d, sellerId: b.sellerId, placeId: b.placeId, stand: b.stands[i], start: '10:00', end: '18:00' }));
  const seen = new Set();
  for (const b of all) {
    const k = b.sellerId + '|' + b.date;
    assert.ok(!seen.has(k), 'myyjä kahdesti samana päivänä: ' + k);
    seen.add(k);
  }
  const byStand = {};
  for (const b of all) (byStand[`${b.date}|${b.placeId}|${b.stand}`] = byStand[`${b.date}|${b.placeId}|${b.stand}`] || []).push([A.tmin(b.start), A.tmin(b.end)]);
  for (const [k, list] of Object.entries(byStand)) {
    const [, pid, st] = k.split('|');
    assert.ok(A.peakLoad(list) <= A.standCap(A.place(pid), st), 'kapasiteetti ylittyy: ' + k);
  }
});

test('suunnittelija: samat syötteet antavat saman ehdotuksen ja jakson pituutta voi rajata', () => {
  assert.equal(JSON.stringify(plan()), JSON.stringify(plan()));
  const one = plan({ maxBlock: 1 });
  assert.ok(one.blocks.every((b) => b.dates.length === 1));
  assert.ok(plan({ maxBlock: 2 }).blocks.some((b) => b.dates.length === 2), 'kahden päivän jaksoja pitäisi syntyä');
});

test('suunnittelija: kotiosoitteeton myyjä, pieni säde ja pelkät vapaat myyjät', () => {
  const s0 = A.S.sellers[0], s1 = A.S.sellers[1];
  const keepHome = s0.home, keepRadius = s1.radiusKm;
  s0.home = null;
  s1.radiusKm = 1;
  let r = plan();
  assert.ok(r.unplaced.some((u) => u.sellerId === s0.id && u.reason === 'Kotiosoite puuttuu'));
  assert.ok(!r.blocks.some((b) => b.sellerId === s0.id));
  assert.ok(r.unplaced.some((u) => u.sellerId === s1.id) || !r.blocks.some((b) => b.sellerId === s1.id));
  s0.home = keepHome; s1.radiusKm = keepRadius;
  // vain myyjät, joilla ei ole vuoroja viikolla
  r = plan({ onlyFree: true });
  const week = Array.from({ length: 7 }, (_, i) => DAY(i));
  for (const b of r.blocks) assert.ok(!A.S.bookings.some((x) => x.sellerId === b.sellerId && week.includes(x.date)));
});

test('suunnittelija: valitut työpäivät rajaavat ehdotukset', () => {
  const r = plan({ days: [1, 3] });
  for (const b of r.blocks) for (const d of b.dates) assert.ok([DAY(1), DAY(3)].includes(d));
  assert.ok(r.blocks.every((b) => b.dates.length === 1));                              // ti ja to eivät ole peräkkäisiä
});

test('suunnittelija: hyväksyminen luo vahvistamattomat, konfliktittomat varaukset', () => {
  const before = A.S.bookings.length;
  const r = plan();
  const { made, skipped } = A.acceptBlocks(r.blocks, r.options);
  assert.equal(skipped.length, 0);
  assert.equal(made.length, r.bookings);
  assert.equal(A.S.bookings.length, before + made.length);
  assert.ok(made.every((b) => b.status === 'tentative'));
  for (const b of made) assert.deepEqual(A.conflicts(b, b.id).filter((c) => c.level === 'error'), [], 'virhe: ' + b.date);
  // uusi ehdotus samalle viikolle ei enää lupaa samoille myyjille samoja päiviä
  const r2 = plan();
  for (const b of r2.blocks) for (const d of b.dates) assert.ok(!made.some((m) => m.sellerId === b.sellerId && m.date === d));
});

test('piiri: myyjän piirissä olevat kohteet ovat lähimmästä kaukaisimpaan ja säteen sisällä', () => {
  const s = A.S.sellers.find((x) => A.sRadius(x) === 150) || A.S.sellers[0];
  const r = A.rangeData(s);
  const km = r.places.map((x) => x.km);
  assert.deepEqual(km, [...km].sort((a, b) => a - b));
  assert.ok(km.every((k) => k <= A.sRadius(s)));
  const small = { ...s, radiusKm: 5 };
  assert.ok(A.rangeData(small).places.length <= r.places.length);
});

test('OpenStreetMap-paikat DEMO-tilassa: lähialuehaku ja aluehaku', async () => {
  const near = await A.poisNear(60.17, 24.94, 40, ['fuel', 'supermarket', 'mall', 'exhibition', 'department_store'], 100);
  assert.ok(near.length > 0);
  const d = near.map((p) => p.distanceKm);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.ok(d.every((x) => x <= 40));
  const fuel = await A.poisBbox([24.0, 60.0, 26.0, 61.0], ['fuel'], 500);
  assert.ok(fuel.length > 0 && fuel.every((p) => p.kind === 'fuel' && p.lat >= 60 && p.lat <= 61));
  assert.ok(A.demoPois().every((p) => p.name.startsWith('Esimerkki')));            // DEMOssa ei ole oikeita paikkoja
});

test('suunnittelija: paikkaa vaihdetaan jaksojen välillä, jos piirissä on vaihtoehtoja', () => {
  const F = load();                                                                   // tuore tila (edelliset testit ovat jo täyttäneet viikon)
  const r = F.planWeek({ weekStart: F.addISO(F.startOfWeek(F.T()), 7) });
  const cand = (s) => F.S.places.filter((p) => !p.neg && F.haversine(s.home, p) <= F.sRadius(s)).length;
  const bySeller = {};
  for (const b of r.blocks) (bySeller[b.sellerId] = bySeller[b.sellerId] || []).push(b);
  let rotated = 0;
  for (const [id, list] of Object.entries(bySeller)) {
    const s = F.seller(id);
    if (cand(s) < 2) continue;
    list.sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
    for (let i = 1; i < list.length; i++) assert.notEqual(list[i].placeId, list[i - 1].placeId, `${s.name}: sama paikka peräkkäin`);
    rotated++;
  }
  assert.ok(rotated > 5, 'testin pitää koskea useita myyjiä, oli ' + rotated);
  assert.ok(r.blocks.every((b) => b.dates.length <= 2));
});

test('osaamisvaroitus: kohteen vaadittu osaaminen näkyy varoituksena, ei estä varausta', () => {
  const F = load();
  const p = F.S.places[0], s = F.S.sellers.find((x) => !(x.skills || []).includes('Kokenut ständimyyjä'));
  p.requiredSkill = 'Kokenut ständimyyjä';
  const nb = { date: F.addISO(F.T(), 20), start: '10:00', end: '18:00', sellerId: s.id, placeId: p.id, stand: p.stands[0].id, status: 'confirmed' };
  const c = F.conflicts(nb, '');
  assert.ok(c.some((x) => x.level === 'warn' && x.code === 'skill'), 'osaamisvaroituksen pitäisi näkyä');
  assert.ok(!c.some((x) => x.level === 'error'), 'osaaminen ei saa estää varausta, vain varoittaa');
  s.skills = ['Kokenut ständimyyjä'];
  assert.ok(!F.conflicts(nb, '').some((x) => x.code === 'skill'), 'varoitus katoaa kun osaaminen lisätään');
});

test('CSV-jäsennin: lainausmerkit, pilkut/puolipisteet ja tyhjät rivit', () => {
  const F = load();
  const rows = F.parseCSV('Nimi;Kaupunki\n"Yritys; Oy";Turku\n\nToinen Oy;Vaasa\n');
  assert.deepEqual(rows, [['Nimi', 'Kaupunki'], ['Yritys; Oy', 'Turku'], ['Toinen Oy', 'Vaasa']]);
  const commaRows = F.parseCSV('a,b,c\n1,2,3\n');
  assert.deepEqual(commaRows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('vCard-jäsennin: FN, N, TEL, EMAIL, ADR useasta kortista', () => {
  const F = load();
  const vcf = 'BEGIN:VCARD\nVERSION:3.0\nFN:Maria Virtanen\nTEL:040 123 4567\nEMAIL:maria@example.fi\nADR:;;Katu 1;Tampere;;00100;Suomi\nEND:VCARD\nBEGIN:VCARD\nN:Korhonen;Kalle;;;\nEND:VCARD\n';
  const cards = F.parseVCard(vcf);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'Maria Virtanen');
  assert.equal(cards[0].phone, '040 123 4567');
  assert.equal(cards[0].city, 'Tampere');
  assert.equal(cards[1].name, 'Kalle Korhonen');
});

test('validointi: sähköposti ja puhelin', () => {
  const F = load();
  assert.equal(F.validEmail(''), true);
  assert.equal(F.validEmail('a@b.fi'), true);
  assert.equal(F.validEmail('ei-kelpaa'), false);
  assert.equal(F.validPhone(''), true);
  assert.equal(F.validPhone('040 123 4567'), true);
  assert.equal(F.validPhone('123'), false);
});
