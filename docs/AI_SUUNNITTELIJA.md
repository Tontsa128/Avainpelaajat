# Avainpelaajat – AI-suunnittelija v1

## Tavoite
AI-suunnittelija muodostaa myyjälle kuukausikalenterin ehdotuksen myyjän kotipisteen ympäriltä. Oletusalue on 100 km. AI ei tee oikeaa varausta automaattisesti: tulos on aina hyväksyttävä ennen kuin se muutetaan varaukseksi.

## Suunnitteluketju
1. Myyjän kotipiste → sädehaku.
2. Paikat suodatetaan ja niille lasketaan etäisyys.
3. Paikat pisteytetään etäisyyden, asiakasvirran, myyntipotentiaalin, saatavuuden, hinnan ja toteutuneen historian perusteella.
4. Kuukausipäivät täytetään 1–2 päivän jaksoissa.
5. Ehdotuksiin tallennetaan selitys ja tila ai_suggestion.
6. Käyttäjä tarkistaa ja hyväksyy ehdotukset.

## Seuraavat vaiheet
- yhdistä suunnittelija nykyiseen käyttöliittymään
- myyjän työprofiili ja kotipisteen geokoodaus
- CRM:n paikka-/yhteyshenkilödata
- toteutuneen myynnin historiadata
- tieverkon mukainen ajoaika ja kilometrien optimointi
- vaihtoehtoinen paikka peruuntumisen jälkeen
- hyväksyntä: kaikki / myyjä / yksittäinen päivä
- AI-selitys käyttöliittymässä
- tuotantotason tietokantataulut suunnitelmille ja suunnitelmariveille
