// Asiakastietojen tuonti valokuvasta (käyntikortti, lista). Käyttää Anthropicin Messages-rajapintaa
// näkökyvyllä. API-avain pysyy vain palvelimella – selain ei koskaan näe sitä. Ilman avainta
// päätepiste vastaa selkeästi 501:llä, jotta käyttöliittymä voi ohjata muihin tuontitapoihin.
import { HttpError, isObj, bad } from './http.js';

const MAX_IMAGE_B64 = Math.ceil((8 * 1024 * 1024) / 3) * 4; // ~8 Mt alkuperäistä kuvaa vastaava base64-koko
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);

const FIELD_SPEC = {
  leads: ['name', 'city', 'contactName', 'phone', 'email', 'notes'],
  sellers: ['name', 'phone', 'email', 'team', 'region'],
};

function buildPrompt(target) {
  const fields = FIELD_SPEC[target];
  const example = target === 'leads'
    ? '[{"name":"Kauppakeskus Esimerkki","city":"Tampere","contactName":"Maria Virtanen","phone":"040 123 4567","email":"maria@example.fi","notes":"Vuokrauspäällikkö"}]'
    : '[{"name":"Matti Myyjä","phone":"040 123 4567","email":"matti@example.fi","team":"","region":""}]';
  return `Kuvassa on käyntikortti tai yhteystietolista. Poimi jokainen erillinen yhteystieto ja palauta VAIN JSON-taulukko (ei selityksiä, ei koodilohkomerkintää), jossa jokaisella alkiolla on kentät: ${fields.join(', ')}. Käytä tyhjää merkkijonoa, jos tietoa ei ole. Esimerkki muodosta: ${example}`;
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Kutsuu tekoälyn näkökykyä. Eristetty omaksi funktioksi, jotta testit voivat ohittaa oikean verkkokutsun. */
export async function callVision(config, { imageBase64, mediaType, target }) {
  const res = await fetch(config.aiApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.aiApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.aiModel,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: buildPrompt(target) },
        ],
      }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(502, 'ai_error', `Tekoälypalvelu vastasi ${res.status}.`, { body: body.slice(0, 300) });
  }
  const json = await res.json();
  const textBlock = (json.content || []).find((b) => b.type === 'text');
  return extractJson(textBlock ? textBlock.text : '');
}

function sanitizeItems(items, target) {
  const fields = FIELD_SPEC[target];
  return items
    .filter((it) => isObj(it) && typeof it.name === 'string' && it.name.trim())
    .slice(0, 25)
    .map((it) => {
      const out = {};
      for (const f of fields) out[f] = typeof it[f] === 'string' ? it[f].trim().slice(0, 200) : '';
      return out;
    });
}

export function registerImportRoutes(router, { config, limiter }) {
  router.post('/api/import/photo', { org: true, roles: ['Admin', 'Buukkaaja', 'Esihenkilö'] }, async (ctx) => {
    const b = ctx.body || {};
    if (b.target !== 'leads' && b.target !== 'sellers') throw bad('Kenttä "target" pitää olla "leads" tai "sellers".');
    if (!config.aiApiKey) {
      throw new HttpError(501, 'ai_not_configured', 'Tekoälytunnistusta ei ole otettu käyttöön palvelimella. Aseta ANTHROPIC_API_KEY .env-tiedostoon, tai käytä CSV- tai vCard-tuontia.');
    }
    const mediaType = String(b.mediaType || '').toLowerCase();
    if (!ALLOWED_MEDIA.has(mediaType)) throw bad('Kuvan tyyppi pitää olla JPEG, PNG tai WebP.');
    const image = typeof b.image === 'string' ? b.image.replace(/^data:[^,]+,/, '') : '';
    if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) throw bad('Kuvadata puuttuu tai on virheellinen.');
    if (image.length > MAX_IMAGE_B64) throw new HttpError(413, 'too_large', 'Kuva on liian suuri (enintään 8 Mt).');
    if (!limiter.hit(ctx.user.id)) throw new HttpError(429, 'too_many_attempts', 'Liian monta kuvatunnistusta. Yritä myöhemmin uudelleen.');
    let items;
    try {
      items = await callVision(config, { imageBase64: image, mediaType, target: b.target });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'ai_unreachable', 'Tekoälypalveluun ei saatu yhteyttä.');
    }
    return { items: sanitizeItems(items, b.target) };
  });
}
