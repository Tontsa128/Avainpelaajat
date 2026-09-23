# Arkkitehtuuri

```
Selain (index.html)  ──HTTPS/JSON──▶  Palvelin (server/)  ──▶  SQLite (server/data/avainpelaaja.db)
 localStorage: DEMO + TYÖ              kirjautuminen, roolit,
 (toimii myös ilman palvelinta)        organisaatiot, validointi
```

## Periaatteet

- **Ei ulkoisia riippuvuuksia.** Palvelin käyttää vain Noden omia moduuleja (`http`, `crypto`, `node:sqlite`, `node:test`). Ei `npm install` -vaihetta, joten käyttöönotto ja tietoturvapäivitykset ovat yksinkertaisia. Vaatii Noden 22.13 tai uudemman.
- **Monivuokraaja.** Jokainen liiketoimintarivi kuuluu organisaatiolle (`org_id`). Organisaatio päätellään tunnistautuneen käyttäjän jäsenyydestä (`memberships`), ei koskaan pelkästä pyynnön sisällöstä. Testit todentavat, ettei organisaatio näe eikä voi muokata toisen dataa.
- **Roolit palvelimella.** Käyttöliittymän piilotetut painikkeet eivät ole suojaus. Jokainen kirjoitus tarkistetaan roolia vasten (`server/routes.js`, `WRITE`). Myyjä-käyttäjä on sidottu omaan myyjäprofiiliinsa: hän näkee ja kirjaa vain omat vuoronsa, työaikansa ja tuloksensa.
- **Varauskonfliktit kahdesti.** Käyttöliittymä varoittaa heti, ja palvelin estää päällekkäisen myyjän tai täyden ständin viimeisenä puolustuksena. Ständillä voi olla 1–4 myyjää samaan aikaan (kapasiteetti asetetaan kohteen tiedoissa).
- **Tietuekohtainen synkronointi.** Käyttöliittymä lähettää vain muuttuneet tietueet ja hakee muiden muutokset 20 sekunnin välein. Rinnakkaismuokkaus hylkää vain sen yksittäisen tietueen, jota kaksi käyttäjää muutti yhtä aikaa.
- **Audit.** Jokainen kirjoitus kirjataan `audit_log`-tauluun (kuka, mitä, milloin).
- **Turvallisuus.** Salasanat scrypt-tiivisteinä, HS256-tokenit, kirjautumisyritysten rajoitus, pyyntökoon raja, CORS-rajaus, tietoturvaotsikot ja CSP palvelimen tarjoamalle etusivulle.

## Sijainti, kartta ja suunnittelija

- **OpenStreetMap, ei Google Places.** Googlen Places-palvelun sisältöä ei saa tallentaa omaan tietokantaan (vain paikan tunniste sallitaan pysyvästi) eikä näyttää muun kuin Googlen kartan päällä, joten paikat tuodaan OpenStreetMapista (ODbL, lähdemaininta pakollinen). Google säilyy vain navigointi- ja "Avaa Google Mapsissa" -linkeissä, jotka ovat ilmaisia.
- **Kattavuus.** OpenStreetMapin merkinnät vaihtelevat: huoltoasemat ja kauppakeskukset ovat yleensä hyvin mukana, messu- ja tapahtumapaikat epätasaisemmin (`amenity=exhibition_centre`, `conference_centre` ja `events_venue`). Päättäjien yhteystiedot eivät ole datassa, ne lisätään CRM:ään.
- **Kotiosoite.** Henkilötietoa: näkyy vain Adminille, Buukkaajalle ja Esihenkilölle, ja palvelin poistaa sen Myyjä- ja Raportointi-rooleilta. Osoitehaku tehdään palvelimen kautta. Etäisyys on linnuntietä (ajomatka on pidempi).
- **Viikkosuunnittelija** ajetaan käyttöliittymässä. Se on sääntöpohjainen ja deterministinen: pisteytys perustuu piiriin, myyntihistoriaan, tarpeisiin ja siihen, ettei samaa paikkaa toisteta. Ehdotus on luonnos, ja hyväksytyt varaukset syntyvät vahvistamattomina.

## Tietokanta

| Taulu | Sisältö |
|---|---|
| `organizations` | Organisaatio, asetukset (JSON), versionumero `rev` |
| `users`, `memberships` | Käyttäjät, heidän roolinsa organisaatioissa ja Myyjä-roolin linkki myyjäprofiiliin (`seller_id`) |
| `sellers`, `places`, `bookings` | Päätaulut: indeksoidut hakukentät + koko olio JSONina (`data`) |
| `records` | CRM-kohteet, kampanjat, aikamerkinnät, poikkeamat, vuoronvaihdot, ilmoitukset, ilmoitustaulu |
| `audit_log` | Palvelimen muutosloki |
| `pois`, `meta` | OpenStreetMap-paikat (jaettu viitedata) ja tuonnin ajankohta |

Skeema on versioitu (`PRAGMA user_version`, nyt versio 3). Vanha tietokanta päivittyy automaattisesti käynnistyksessä. Uudet muutokset lisätään `server/db.js`:ään uutena vaiheena.

## Tunnetut rajoitukset ja seuraavat askeleet

1. **Ristiriidat ratkaistaan tietuetasolla.** Jos kaksi käyttäjää muokkaa samaa tietuetta (esim. samaa myyjäprofiilia) yhtä aikaa, ensin tallentanut voittaa. Toiselle näytetään ilmoitus ja hänen versionsa tallennetaan selaimeen avaimella `avainpelaaja-os:conflict-backup`. Kenttätason yhdistämistä ei ole.
2. **Muutokset haetaan kyselyllä, ei reaaliaikaisesti.** Toisen käyttäjän muutos näkyy enintään ~20 sekunnin viiveellä (tai heti oman tallennuksen yhteydessä). Reaaliaikainen päivitys (SSE tai WebSocket) on seuraava askel.
3. **Myyjä-tilin linkitys on tehty käsin.** Ylläpitäjä linkittää käyttäjän myyjäprofiiliin jäsenlistasta. Automaattinen linkitys sähköpostin perusteella voidaan lisätä myöhemmin.
4. **Ei sähköpostivahvistusta eikä salasanan palautusta.** Ylläpitäjä lisää jäsenet ja antaa väliaikaisen salasanan.
5. **Yksi palvelininstanssi.** SQLite sopii yhdelle instanssille pysyvällä levyllä. Suuremmalle käytölle vaihdetaan PostgreSQL:ään (`server/store.js` on ainoa tietokantakerros).
6. **Osaamisvaroitus on ohjeellinen.** Se ei estä varausta, koska ständikohtaisia poikkeuksia on aina (sijaisuudet, harjoittelijat). Jos tästä halutaan pakottava sääntö, se on yhden rivin muutos (`level:'error'`).
7. **Etäisyys on linnuntietä.** Ajoaika ja -matka (reititys) voidaan lisätä myöhemmin. Piirin rajalla olevat paikat voivat siksi olla todellisuudessa kauempana.
8. **Oikea AI.** AI-keskus on sääntöpohjainen. Kielimalli liitetään palvelimeen (avain vain palvelimella, ei selaimessa).
