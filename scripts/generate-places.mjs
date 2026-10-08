// Builds places/places.tsv.br, the offline gazetteer that turns the
// free-text locations carriers print into map places.
//
// Sources, downloaded into a cache directory on the first run:
// - GeoNames cities1000, first-level regions and postal codes, CC BY 4.0: https://www.geonames.org
// - OurAirports airports, public domain: https://ourairports.com/data/
// - Country label points from places/countries.json (Natural Earth, public domain)
//
// Run: node scripts/generate-places.mjs [cache directory]. Needs `unzip`.
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { nameKey, nameKeys } from '../places/names.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.argv[2] ?? '/tmp/universal-parcel-scraper-places';
const output = join(root, 'places/places.tsv.br');
// Small towns in these countries often host sorting centres, so every
// locality in their postal files becomes a place. Belgian municipalities
// ("Grâce-Hollogne", by Liège airport) are not GeoNames towns at all.
const LOCALITY_COUNTRIES = ['CH', 'LI', 'AT', 'DE', 'FR', 'IT', 'BE', 'LU', 'NL'];
// Only these carriers print postcodes ("Härkingen 4622").
const POSTCODE_COUNTRIES = new Set(['CH', 'LI']);
// Exonyms and translations ("Genf", "Cologne") matter for towns, not hamlets,
// and for smaller towns only where they have several official names.
const ALTERNATES_FROM = 50_000;
const BILINGUAL_FROM = 10_000;
const MULTILINGUAL = new Set(['CH', 'LI', 'AT', 'DE', 'FR', 'IT', 'BE', 'LU', 'NL']);
// Chinese, Japanese and Korean carriers print towns in their own script ("深圳市").
const CJK_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW', 'JP', 'KR']);
const SKIPPED_FEATURES = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
// Chinese carriers lead with the province ("广东省深圳市"); GeoNames names them only in English.
const CHINESE_PROVINCES = {
  '01': '安徽', '02': '浙江', '03': '江西', '04': '江苏', '05': '吉林', '06': '青海', '07': '福建', '08': '黑龙江', '09': '河南',
  10: '河北', 11: '湖南', 12: '湖北', 13: '新疆', 14: '西藏', 15: '甘肃', 16: '广西', 18: '贵州', 19: '辽宁', 20: '内蒙古',
  21: '宁夏', 22: '北京', 23: '上海', 24: '山西', 25: '山东', 26: '陕西', 28: '天津', 29: '云南', 30: '广东', 31: '海南',
  32: '四川', 33: '重庆',
};
// What a region's name adds to the place it names: "Inner Mongolia Autonomous Region", "Gyeonggi-do".
const REGION_WORDS = /\s+(autonomous region|special administrative region|region|province|prefecture|voivodeship|oblast|do)$/;
// Without those words, some names are only a direction or a common word ("Central Region", "Capital Region").
const GENERIC_REGIONS = new Set('central capital north south east west northern southern eastern western upper lower greater middle coast islands'.split(' '));

async function download(file, url) {
  const path = join(cache, file);
  try {
    await access(path);
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await mkdir(cache, { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
  return path;
}

const unzip = (zip, entry) => execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
const lines = (text) => text.split('\n').filter(Boolean).map((line) => line.split('\t'));
// About 100 m: plenty for a dot on a city.
const round = (value) => Math.round(Number(value) * 1e3) / 1e3;
const latin = (name) => /^[\p{Script=Latin} '’.\-()]{3,40}$/u.test(name) && !/^[A-Z]{2,5}$/.test(name);
const cjk = (name) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,12}$/u.test(name);

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** RFC 4180 rows: quoted fields may hold commas and doubled quotes. */
function csv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      rows.push([...row, field.replace(/\r$/, '')]);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

const cities = unzip(await download('cities1000.zip', 'https://download.geonames.org/export/dump/cities1000.zip'), 'cities1000.txt');
const places = [];
const byKey = new Map();
function remember(place) {
  places.push(place);
  for (const key of place.primary) {
    const list = byKey.get(`${place.country}:${key}`) ?? [];
    list.push(place);
    byKey.set(`${place.country}:${key}`, list);
  }
}

for (const [, name, ascii, alternates, lat, lon, featureClass, feature, country, , admin1, admin2, , , population] of lines(cities)) {
  if (featureClass !== 'P' || SKIPPED_FEATURES.has(feature)) continue;
  const primary = new Set([...nameKeys(name), ...nameKeys(ascii)]);
  const alternate = new Set();
  if (Number(population) >= (MULTILINGUAL.has(country) ? BILINGUAL_FROM : ALTERNATES_FROM)) {
    for (const other of alternates.split(',')) {
      if (!latin(other) && !(CJK_COUNTRIES.has(country) && cjk(other))) continue;
      for (const key of nameKeys(other)) if (!primary.has(key)) alternate.add(key);
    }
  }
  remember({
    name, ascii, country, admin1, admin2: country === 'FR' || country === 'IT' ? admin2 : '', lat: round(lat), lon: round(lon),
    population: Number(population) || 0, primary: [...primary], alternate: [...alternate],
  });
}
const listed = places.length;

// Postal files: every locality, and for CH and LI every postcode.
const postcodes = new Map();
for (const country of LOCALITY_COUNTRIES) {
  const rows = lines(unzip(await download(`${country}.zip`, `https://download.geonames.org/export/zip/${country}.zip`), `${country}.txt`));
  for (const [, code, rawName, , admin1, , admin2, , , lat, lon, accuracy] of rows) {
    // "Buchs SG 1" and "Paris 01" are postal subdivisions of "Buchs" and "Paris".
    const name = rawName.replace(/(\s+(\d+|[A-Z]{2}|SC|PF))+$/u, '').trim();
    const point = [round(lat), round(lon)];
    if (POSTCODE_COUNTRIES.has(country) && !postcodes.has(`${country}:${code}`)) {
      postcodes.set(`${country}:${code}`, { country, code, name, lat: point[0], lon: point[1] });
    }
    // Rows without an accuracy are companies and post boxes, not places.
    if (!accuracy || !latin(name)) continue;
    const keys = nameKeys(name);
    const known = keys.some((key) => (byKey.get(`${country}:${key}`) ?? [])
      .some((place) => distanceKm(point, [place.lat, place.lon]) < 15));
    if (known) continue;
    remember({
      name, ascii: name, country, admin1, admin2: country === 'FR' || country === 'IT' ? admin2 : '', lat: point[0], lon: point[1],
      population: 0, primary: keys, alternate: [],
    });
  }
}

// First-level regions by name ("Ontario", "Virginia", "Guangdong"): scans name
// them after the town, and they tell towns of one name apart.
const regions = [];
for (const [id, name, ascii] of lines(await readFile(await download('admin1CodesASCII.txt', 'https://download.geonames.org/export/dump/admin1CodesASCII.txt'), 'utf8'))) {
  const [country, admin1] = id.split('.');
  const keys = new Set([...nameKeys(name), ...nameKeys(ascii)]);
  for (const key of [...keys]) if (!GENERIC_REGIONS.has(key.replace(REGION_WORDS, ''))) keys.add(key.replace(REGION_WORDS, ''));
  if (country === 'CN' && CHINESE_PROVINCES[admin1]) keys.add(CHINESE_PROVINCES[admin1]);
  regions.push({ country, admin1, keys: [...keys].filter((key) => key.length >= 2) });
}

// Airports with scheduled flights, for scans that name one ("Frankfurt Airport (FRA)").
const airports = csv(await readFile(await download('airports.csv', 'https://davidmegginson.github.io/ourairports-data/airports.csv'), 'utf8'))
  .filter((airport) => ['large_airport', 'medium_airport'].includes(airport.type) && airport.scheduled_service === 'yes'
    && /^[A-Z]{3}$/.test(airport.iata_code) && airport.iso_country)
  .map((airport) => [airport.iata_code, airport.iso_country, round(airport.latitude_deg), round(airport.longitude_deg),
    airport.name.trim(), airport.municipality.trim()])
  .sort(([a], [b]) => a.localeCompare(b));

const world = JSON.parse(await readFile(join(root, 'places/countries.json'), 'utf8'));
const countries = world.countries.filter((country) => country.code && country.label)
  .map((country) => [country.code, country.name, country.label[0], country.label[1]])
  .sort(([a], [b]) => a.localeCompare(b));

places.sort((a, b) => a.country.localeCompare(b.country) || nameKey(a.name).localeCompare(nameKey(b.name)) || a.lat - b.lat || a.lon - b.lon);
regions.sort((a, b) => a.country.localeCompare(b.country) || a.admin1.localeCompare(b.admin1));
const text = [
  '# Places for carrier scan locations. Generated by scripts/generate-places.mjs.',
  '# GeoNames (https://www.geonames.org), CC BY 4.0. Country points: Natural Earth, public domain. Airports: OurAirports, public domain.',
  ...countries.map((country) => ['C', ...country].join('\t')),
  ...regions.map((region) => ['R', region.country, region.admin1, region.keys.join(',')].join('\t')),
  ...airports.map((airport) => ['A', ...airport].join('\t')),
  // Primary keys are recomputed from the names when the file is read, and
  // population in thousands is all the ranking needs.
  ...places.map((place) => ['P', place.name, nameKey(place.ascii) === nameKey(place.name) ? '' : place.ascii, place.country,
    place.admin1, place.admin2, place.lat, place.lon, Math.round(place.population / 1000), place.alternate.join(',')].join('\t')),
  ...[...postcodes.values()].sort((a, b) => a.country.localeCompare(b.country) || a.code.localeCompare(b.code))
    .map((entry) => ['Z', entry.country, entry.code, entry.lat, entry.lon, entry.name].join('\t')),
].join('\n');
const compressed = brotliCompressSync(text, { params: {
  [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: text.length,
} });
await writeFile(output, compressed);
console.log(`places.tsv.br: ${countries.length} countries, ${regions.length} regions, ${airports.length} airports, ${listed} GeoNames places, `
  + `${places.length - listed} postal localities, ${postcodes.size} postcodes, ${Math.round(text.length / 1024)} KB, `
  + `${Math.round(compressed.length / 1024)} KB compressed`);
