# Avainpelaaja OS – arkkitehtuuri

`index.html` on käyttöliittymä. `server/app.js` on HTTP-palvelin. `server/routes.js` sisältää API-reitit. `server/store.js` ja `server/db.js` muodostavat SQLite-tietokerroksen. `server/auth.js` hoitaa salasanat ja tokenit. `server/sync.js` hoitaa versionumeroon perustuvan synkronoinnin.

SQLite käyttää WAL-tilaa. Kaikki sovellusdata on organisaatioon sidottu.

Varaus tarkistetaan myyjän päällekkäisen ajan ja kauppapaikan/ständin päällekkäisyyden osalta.

Palvelin sitoutuu oletuksena `127.0.0.1`:een. Tuotannossa käytä TLS:ää/reverse proxyä, pitkää `JWT_SECRET`-avainta ja pysyvää levyä.

OSM-moduulin mukana tuleva aineisto on esimerkkidata; tuotantokartta tarvitsee oikean OSM-yhteensopivan datapalvelun ja attribuutiot.
