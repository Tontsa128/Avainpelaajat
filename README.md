# Avainpelaaja OS

Ständimyynnin operatiivinen järjestelmä: kauppapaikat, CRM, varaukset, myyjät, työajat, myynti, raportit ja AI-avustaja.
Yksi tiedosto (`index.html`), ei asennusta eikä rakennusvaihetta. Toimii puhelimella, tabletilla ja tietokoneella.

## Tilat

| Painike | Mitä tekee |
|---|---|
| 🧪 **DEMO** | Esimerkkidataa (40 myyjää, 16 kauppapaikkaa, varauksia, CRM-kohteita). Voit kokeilla vapaasti ja palauttaa alkutilaan. |
| 💼 **TYÖ** | Tyhjä. Täytät oman datan itse. Aloitusopas vie läpi: kauppapaikka → myyjät → varaus → CRM. |

DEMO- ja TYÖ-data tallentuvat erikseen, eikä kumpikaan sotke toista.

## Ominaisuudet

- **Dashboard**: päivän tilanne, KPI:t, "Vaatii huomiota", buukkaamattomat tarpeet, 14 päivän kaupat, myyntianalytiikka, kampanjat
- **Kalenteri**: päivä-, viikko-, myyjä- ja kuukausinäkymä. Konfliktitarkistus (myyjän tai ständin päällekkäisyys, siirtymäaika, liian pitkä vuoro, sopimuksen ulkopuolinen päivä, poissaolo). Vedä ja pudota (tietokone)
- **CRM**: kanban ja soittolista, jokaisella kohteella pakollinen status + seuraava toimenpide + päivä, puhelumuistiinpanot, kohteen muunto kauppapaikaksi
- **Mobiili**: myyjän päivä (navigointi, aloita / tauko / jatka / lopeta, kauppalaskuri, loppuraportti, vuoronvaihtopyyntö)
- **Myyjät**: haku ja suodatus, profiili, sopivimmat paikat, poissaolot
- **Kohteet**: hinnat, kävijät, ständit, yhteyshenkilöt, dokumentit, laatuhistoria, sisäinen pistemäärä, vertailu (2–4 kohdetta)
- **Kartta**: Suomen kartta, vapaat / varatut / neuvottelussa, potentiaaliset CRM-kohteet
- **Raportit**: myyjä, kohde, alue, kampanja, ennuste. CSV (Excel), kopiointi ja PDF (tulostus)
- **AI Action Center**: seuraavat tehtävät ja kysymykset. Kertoo aina, mihin dataan vastaus perustuu, eikä muuta mitään itse
- **Lisää**: kampanjat, poikkeamat, ilmoitustaulu, vuoronvaihdot, muutosloki, asetukset, varmuuskopio
- Roolit (esikatselu): Admin, Buukkaaja, Esihenkilö, Myyjä, Raportointikäyttäjä (vain luku)
- Tilat merkitään värin lisäksi symbolilla ja tekstillä

## Käyttöönotto GitHub Pagesilla (puhelimella)

1. Avaa repo GitHubissa → **Add file → Upload files** → lisää `index.html` ja `README.md` → **Commit changes**.
2. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / `(root)` → **Save**.
3. Hetken päästä sivu aukeaa osoitteessa `https://<käyttäjä>.github.io/<repo>/`.
4. Lisää sivu puhelimen aloitusnäytölle selaimen valikosta.

## Tärkeää tietää

- Data tallentuu **vain käyttämäsi laitteen selaimeen** (localStorage). Toisella laitteella data on tyhjä.
- Ota varmuuskopio: **Lisää → Asetukset → Lataa JSON** ja tuo se tarvittaessa takaisin.
- Selaimen tietojen tyhjennys poistaa datan. Varmuuskopio suojaa siltä.
- Roolit ovat tässä versiossa esikatselu. Oikea kirjautuminen tarvitsee palvelimen.

## Seuraava vaihe

Palvelinpuoli (tietokanta, kirjautuminen, monivuokraaja), oikea kielimalli AI-keskukseen, QR-koodit ständeille ja vuorojen
sähköpostit tai tekstiviestit.
