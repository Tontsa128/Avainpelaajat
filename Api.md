# Rajapinta (API)

Kaikki polut alkavat `/api`. Data kulkee JSON-muodossa. Päivät ovat `VVVV-KK-PP`, kellonajat `HH:MM`.

## Tunnistautuminen

1. `POST /api/auth/login` palauttaa `token`in ja käyttäjän `memberships`-listan (organisaatiot ja roolit).
2. Lisää jokaiseen suojattuun pyyntöön:
   - `Authorization: Bearer <token>`
   - `X-Organization-Id: <orgId>` (voi jättää pois, jos käyttäjällä on vain yksi organisaatio)

Token on allekirjoitettu (HS256) ja voimassa `TOKEN_TTL_SEC` sekuntia. Käyttäjä pääsee vain organisaatioihin, joiden jäsen hän on, ja jokainen kysely rajataan organisaatioon palvelimella.

## Virheet

```json
{ "error": { "code": "booking_conflict", "message": "Varaus on ristiriidassa.", "details": { "conflicts": [] } } }
```

| Tila | Koodi | Merkitys |
|---|---|---|
| 400 | `validation`, `bad_json` | Virheellinen syöte |
| 401 | `unauthorized`, `invalid_credentials` | Ei kirjautunut / väärä salasana |
| 403 | `forbidden`, `registration_closed` | Rooli ei riitä / ei pääsyä organisaatioon |
| 404 | `not_found` | Ei löydy |
| 409 | `booking_conflict`, `rev_mismatch`, `exists`, `in_use`, `last_admin`, `seller_taken`, `email_taken` | Ristiriita |
| 413 | `too_large` | Liian suuri pyyntö |
| 429 | `too_many_attempts` | Liian monta kirjautumisyritystä |

## Päätepisteet

| Metodi ja polku | Rooli | Kuvaus |
|---|---|---|
| `GET /api/health`, `GET /api/health/db` | kaikki | Terveystarkistus |
| `POST /api/auth/register` | avoin* | Luo käyttäjän ja organisaation (`email`, `name`, `password`, `organization`) |
| `POST /api/auth/login` | avoin | Kirjautuminen (`email`, `password`) |
| `GET /api/me` | kirjautunut | Käyttäjä ja jäsenyydet |
| `POST /api/auth/password` | kirjautunut | Salasanan vaihto (`current`, `next`) |
| `GET /api/org`, `PATCH /api/org` | kaikki / Admin | Organisaation tiedot ja nimen vaihto |
| `GET/POST /api/org/members`, `PATCH/DELETE /api/org/members/:userId` | Admin | Jäsenten hallinta. Jäsenellä on `role` ja valinnainen `sellerId` (linkki myyjäprofiiliin). `PATCH` hyväksyy `role` ja/tai `sellerId` (`null` purkaa linkin) |
| `GET /api/audit?limit=100` | Admin, Esihenkilö | Palvelimen muutosloki |
| `GET /api/pois?bbox=w,s,e,n&kinds=&q=&limit=` | Admin, Buukkaaja, Esihenkilö | OpenStreetMap-paikat suorakulmion sisällä |
| `GET /api/pois/near?lat=&lon=&km=&kinds=&limit=` | Admin, Buukkaaja, Esihenkilö | Paikat säteen sisällä, lähin ensin (`distanceKm`) |
| `GET /api/pois/stats` | Admin, Buukkaaja, Esihenkilö | Paikkojen määrät tyypeittäin ja tuonnin ajankohta |
| `POST /api/geocode` | Admin, Buukkaaja, Esihenkilö | Osoite → koordinaatit (`{ "q": "Hämeenkatu 10, Tampere" }`) |
| `GET/POST /api/sellers`, `GET/PATCH/DELETE /api/sellers/:id` | luku kaikki, kirjoitus Admin, Esihenkilö | Myyjät |
| `GET/POST /api/places`, `GET/PATCH/DELETE /api/places/:id` | luku kaikki, kirjoitus Admin, Buukkaaja | Kauppapaikat |
| `GET /api/bookings?from=&to=`, `POST`, `GET/PATCH/DELETE /api/bookings/:id` | luku kaikki, kirjoitus Admin, Buukkaaja, Esihenkilö | Varaukset (päällekkäisyys palauttaa 409) |
| `GET/POST /api/records/:kind`, `PATCH/DELETE /api/records/:kind/:id` | katso alla | CRM ja muut kokoelmat |
| `GET /api/workspace` | kaikki | Koko työtila käyttöliittymän muodossa (`rev` + `state`). `?since=<rev>` palauttaa vain `unchanged`, jos ei muutoksia |
| `POST /api/sync` | kaikki paitsi Raportointikäyttäjä | Muuttuneiden tietueiden tallennus (ks. alla) |
| `PUT /api/workspace` | Admin | Koko työtilan korvaus (alkusiirto, tuonti) |

\* Rekisteröityminen on sallittu vain, kun tietokannassa ei ole vielä käyttäjiä tai `ALLOW_REGISTRATION=true`.

`:kind` on jokin näistä: `time`, `leads`, `campaigns`, `needs`, `incidents`, `swaps`, `notifications`, `bulletin`, `audit`.

## Kirjoitusoikeudet kokoelmittain

| Kokoelma | Admin | Buukkaaja | Esihenkilö | Myyjä | Raportointi |
|---|:-:|:-:|:-:|:-:|:-:|
| sellers | ✓ | | ✓ | | |
| places | ✓ | ✓ | | | |
| bookings | ✓ | ✓ | ✓ | vain omien vuorojensa kaupat ja raportti työtilan kautta | |
| time | ✓ | | ✓ | vain omat | |
| leads | ✓ | ✓ | | | |
| campaigns, needs, bulletin | ✓ | ✓ | ✓ | | |
| incidents, swaps, notifications | ✓ | ✓ | ✓ | vain omat (ks. alla) | |
| audit | ✓ | ✓ | ✓ | | |

Tietojen minimointi: Raportointikäyttäjä ei saa muutoslokia.

## Myyjä-käyttäjän rajaukset

Myyjä-roolin käyttäjä on linkitetty yhteen myyjäprofiiliin (`memberships.seller_id`). Ylläpitäjä tekee linkin jäsenlistasta. Palvelin pakottaa seuraavat rajaukset (REST ja `PUT /api/workspace`):

- **Lukeminen:** ei CRM-kohteita eikä muutoslokia. Muiden myyjien puhelin, sähköposti, rajoitteet ja poissaolot tyhjennetään. Muiden varauksista näkyvät vain päivä, aika, paikka, ständi ja tila (ei kauppoja, kirjauksia, huomautuksia eikä raportteja). Aikamerkinnöistä näkyvät vain omat.
- **Kirjoittaminen:** vain oman vuoron kaupat, kirjaukset ja loppuraportti, omat aikamerkinnät, omat poikkeamat ja omat vuoronvaihtopyynnöt. Ilmoituksiin voi vain lisätä. Poistaminen ei ole sallittua. Vuoronvaihtoa ei voi merkitä vahvistetuksi (sen tekee esihenkilö).
- **Linkittämätön tili:** näkee samat rajatut tiedot mutta ei voi kirjoittaa mitään. Käyttöliittymä pyytää ylläpitäjää tekemään linkityksen.
- Myyjäprofiilin poisto purkaa linkityksen automaattisesti. Yhden myyjäprofiilin voi linkittää vain yhdelle käyttäjälle (409 `seller_taken`).

## Myyjän kotiosoite ja työskentelysäde

Myyjätietueella (`sellers`) on valinnaiset kentät:

- `home`: `{ "address": "Hämeenkatu 10", "city": "Tampere", "lat": 61.4981, "lon": 23.7608, "source": "geocode" | "city" }`
- `radiusKm`: työskentelysäde kilometreinä (1–500, oletus 100)

Nämä ovat henkilötietoa ja buukkarin työkaluja: **Myyjä- ja Raportointikäyttäjä-roolille palvelin poistaa `home` ja `radiusKm` kaikista vastauksista** (REST ja työtila). Virheelliset koordinaatit tai säde hylätään (400).

## OpenStreetMap-paikat

Taulu `pois` sisältää huoltoasemat (`fuel`), kauppakeskukset (`mall`), supermarketit (`supermarket`), tavaratalot (`department_store`) ja messu- ja tapahtumapaikat (`exhibition`). Data on jaettua viitedataa (ei organisaatiokohtaista), ja se tuodaan palvelimen ylläpitäjän komennolla eikä rajapinnan kautta. Lähde: © OpenStreetMap contributors (ODbL). Lähdemaininta näytetään kartalla ja vastauksissa. Myyjä-rooli ei näe paikkoja (403).

## Osoitehaku

`POST /api/geocode` kutsuu palvelimelta konfiguroitua osoitehakupalvelua (`GEOCODER_URL`). Osoitteet eivät kulje selaimesta kolmannelle osapuolelle, niitä ei kirjata lokiin, ja kutsuja rajoitetaan (60 / 10 min / käyttäjä, yksi pyyntö sekunnissa palveluun). Jos `GEOCODER_URL=off`, palvelin vastaa 503 `geocoder_disabled`.

## Asiakastietojen tuonti

`POST /api/import/photo` — kuva (käyntikortti tai yhteystietolista) → JSON-lista poimittuja kenttiä.

- Rooli: Admin, Buukkaaja, Esihenkilö.
- Runko: `{ "target": "leads" | "sellers", "mediaType": "image/jpeg" | "image/png" | "image/webp", "image": "<base64>" }`. Enintään ~8 Mt.
- Vastaus: `{ "items": [ { "name": "...", ... } ] }`, enintään 25 riviä, vain sallitut kentät kohteittain.
- Ilman `ANTHROPIC_API_KEY`-ympäristömuuttujaa palvelin vastaa **501** `ai_not_configured` heti, kuvaa ei lähetetä minnekään. Avain ja kaikki kutsut pysyvät palvelimella — selain ei koskaan näe avainta.
- Kutsuja rajoitetaan (20 / tunti / käyttäjä).
- CSV, Excel (.xlsx) ja vCard (.vcf) -tuonti tapahtuu kokonaan selaimessa eikä käytä tätä päätepistettä.

## Ständipaikan kapasiteetti (1–4 myyjää)

Jokaisella kauppapaikan ständillä (`places.stands[]`) on `capacity` (kokonaisluku 1–4, oletus 4): montako myyjää ständillä voi olla **samaan aikaan**.

- Varaus hylätään (409 `booking_conflict`, koodi `stand`), jos ständin samanaikainen myyjämäärä ylittäisi kapasiteetin. Peräkkäiset vuorot (esim. 10–14 ja 14–18) eivät ole päällekkäisiä.
- Sama myyjä ei voi olla kahdessa paikassa yhtä aikaa (koodi `seller`), vaikka ständissä olisi tilaa.
- Virheellinen `capacity` (0, 5, 2.5, merkkijono) hylätään (400).
- Sääntö pakotetaan sekä REST-kutsuissa että synkronoinnissa.

## Työtilan synkronointi

Käyttöliittymä käyttää kolmea kutsua:

| Kutsu | Käyttö |
|---|---|
| `GET /api/workspace` | Koko työtila (`rev`, `sellerId`, `state`). Myyjä-käyttäjälle rajattuna |
| `GET /api/workspace?since=<rev>` | Kevyt kysely: jos mikään ei ole muuttunut, vastaus on `{ "rev": n, "unchanged": true }` |
| `POST /api/sync` | Tallennus: vain muuttuneet tietueet |
| `PUT /api/workspace` | Koko työtilan korvaus (alkusiirto ja varmuuskopion tuonti). **Vain Admin**, vaatii `baseRev` |

### `POST /api/sync`

```json
{
  "baseRev": 12,
  "changes": {
    "sellers":  { "upsert": [ { "item": { "id": "s1", "name": "Anna" }, "base": "abc.def.7" } ], "delete": [ { "id": "s9", "base": "xyz.123.5" } ] },
    "bookings": { "upsert": [ { "item": { "id": "b1", "...": "..." }, "base": null } ] }
  },
  "settings": { "base": "…", "value": { "targetPerShift": 9 } }
}
```

- `base` on sormenjälki tietueesta, jonka käyttäjä on viimeksi nähnyt (`null` = uusi tietue). Sormenjälki on `hashStr(JSON.stringify(tietue))` (ks. `server/util.js`).
- Palvelin vertaa `base`a tietueen nykyiseen sormenjälkeen. Jos tietue on sillä välin muuttunut, **vain se yksittäinen muutos hylätään** ja muut pyynnön muutokset menevät läpi.
- Käsittely: ensin poistot, sitten lisäykset ja muutokset. Roolin oikeudet tarkistetaan ennen versiotarkistusta.
- Uudet ilmoitukset, muutosloki, ilmoitustaulu, poikkeamat ja vuoronvaihdot lisätään listan alkuun, muut loppuun.

Vastaus:

```json
{
  "rev": 13,
  "stale": false,
  "applied":  { "sellers": { "s1": "uusi.sormenjälki.7" }, "campaigns": { "k1": null } },
  "rejected": [ { "kind": "bookings", "id": "b5", "reason": "booking_conflict", "conflicts": [], "server": null } ],
  "settings": { "...": "..." }
}
```

- `applied`: uusi sormenjälki (`null` = poistettu).
- `rejected[].reason`: `conflict` (toinen ehti muuttaa), `deleted_by_other`, `forbidden`, `in_use` (myyjään tai kohteeseen liittyy varauksia), `booking_conflict`. `server` on palvelimen nykyinen versio (tai `null`).
- `stale`: `true`, jos joku muu ehti muuttaa dataa `baseRev`in jälkeen. Käyttöliittymä hakee silloin muutokset.
- `rev` nousee vain, kun jokin muutos meni läpi.
- Asetukset (`settings`) voi muuttaa vain Admin, samalla sormenjälkitarkistuksella.
