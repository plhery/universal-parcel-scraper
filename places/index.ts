
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { ambiguousAddressCodes, trackingPlace } from './trackingLocation.js';
import facilityList from './facilities.json' with { type: 'json' };
import hubList from './hubs.json' with { type: 'json' };
import { nameKey, nameKeys } from './names.mjs';

/** Where a scan happened, as precisely as its free-text location allows. */
export interface EventPlace {
  latitude: number;
  longitude: number;
  precision: 'city' | 'country';
  /** ISO 3166-1 alpha-2. */
  country: string;
  name: string;
  /** The facility name, when distinct from the town. */
  site?: string;
}

/** Where a carrier itself puts a scan's facility (`point` on a stored scan). */
export interface EventPoint {
  latitude: number;
  longitude: number;
}

export interface PlaceHints {
  /** Countries the parcel is likely in, strongest first: neighbouring scans, destination, carrier. */
  countries?: readonly string[];
}

interface Airport { code: string; country: string; latitude: number; longitude: number; name: string; town: string }
interface Region { country: string; admin1: string }

interface Gazetteer {
  names: string[];
  /** Country, admin1 and admin2 as indices into `codes`: most of 230,000 places share a few thousand codes. */
  codes: string[];
  country: Uint16Array;
  admin1: Uint16Array;
  admin2: Uint16Array;
  latitude: Float32Array;
  longitude: Float32Array;
  /** In thousands. Postal localities without a census count are 0. */
  population: Uint32Array;
  /** Place indices; alternate names (exonyms, translations) are stored as ~index. */
  keys: Map<string, number | number[]>;
  postcodes: Map<string, { latitude: number; longitude: number }>;
  countries: Map<string, { name: string; latitude: number; longitude: number }>;
  /** First-level regions by name: "ontario" is CA 08. */
  regions: Map<string, Region[]>;
  /** The names of each region, by country and code: "BG.42" is "sofia capital". */
  regionNames: Map<string, string[]>;
  /** Airports with scheduled flights, by IATA code. */
  airports: Map<string, Airport>;
}

const DATA = new URL('./places.tsv.br', import.meta.url);
// Words for facilities and services rather than places ("Agence DPD de La Crau", "PAKETZENTRUM", "ISC NEW YORK NY(USPS)").
const FACILITY_WORDS = new Set(`
  agence agency air airport area branch bureau cedex cidex center centre centro centrum clasificacion colis
  customs delivery depot deposito destination distribution distribuicao dogana douane export facility filiale
  gateway hub import international intl livraison local location logistics logistik mail oddzial office oficina
  operations operativo origin paketzentrum briefzentrum verteilzentrum sortierzentrum zustellbasis zustellstelle
  parcel parcels plateforme platform point postal postfiliale postfach poste pz bz return service services site
  smistamento sort sorting station terminal tratamento tri unidade ufficio warehouse zentrum zoll zollamt
  dhl ups fedex gls dpd tnt usps colissimo chronopost postnl bpost evri hermes cainiao yanwen parcelforce posti
  planzer quickpac amazon express post home house address recipient sender neighbourhood neighborhood unknown
  courrier courier exchange foreign network processing transit worldwide isc ndc idc piac pic pfc ppdc cdis ctc
  gpo nsh rms tmo fpo aeroport aeroporto aeropuerto flughafen luchthaven lufthavn flygplats lentoasema lotnisko
`.trim().split(/\s+/));
// Administrative words a town can be written with or without ("Jinhua City", "Guangdong Sheng").
const DIVISION_WORDS = new Set('city province prefecture district county shi sheng qu xian si gu do ku ken'.split(' '));
// Words that say a scan happened at an airport ("Frankfurt Airport (FRA)", "HELSINKI-VANTAAN LENTOASEMA").
const AIRPORT_WORDS = new Set('airport aeroport aeroporto aeropuerto flughafen luchthaven lufthavn flygplats lentoasema lotnisko'.split(' '));
// Words of airport names that do not tell one airport from another.
const AIRPORT_NAME_WORDS = new Set(`
  airport international intl regional municipal national field airfield aerodrome air base the de del la le du of and
  city county metropolitan
`.trim().split(/\s+/));
// Region names too vague to place a scan in their country on their own.
const VAGUE_REGIONS = new Set('central capital north south east west centre center islands national federal'.split(' '));
const LEADING_WORDS = new Set(['de', 'du', 'des', 'di', 'da', 'del', 'della', 'von', 'of']);
// Carriers print provinces the way the post does; GeoNames numbers them.
const ADMIN_CODES: Record<string, Record<string, string>> = {
  CA: { AB: '01', BC: '02', MB: '03', NB: '04', NL: '05', NS: '07', ON: '08', PE: '09', QC: '10', SK: '11', YT: '12', NT: '13', NU: '14' },
  AU: { ACT: '01', NSW: '02', NT: '03', QLD: '04', SA: '05', TAS: '06', VIC: '07', WA: '08' },
  BR: {
    AC: '01', AL: '02', AP: '03', AM: '04', BA: '05', CE: '06', DF: '07', ES: '08', MS: '11', MA: '13', MT: '14', MG: '15',
    PA: '16', PB: '17', PR: '18', PI: '20', RJ: '21', RN: '22', RS: '23', RO: '24', RR: '25', SC: '26', SP: '27', SE: '28',
    GO: '29', PE: '30', TO: '31',
  },
};
// A place nothing else confirms has to be a known town, not a hamlet with the same name.
const UNCONFIRMED_MIN_THOUSANDS = 15;
// A carrier's own point for a scan has to agree with the town its text names.
const POINT_MAX_KM = 30;
// An airport a scan names has to be this close to the town it names.
const AIRPORT_MAX_KM = 60;
// A hub nickname ranks like a town of this many thousand people, so a longer
// name that contains it ("Roissy-en-Brie") still wins.
const HUB_THOUSANDS = 50;
/** The city a region is named after ("Santo Domingo Province") has at least this many thousand people. */
const NAMESAKE_THOUSANDS = 100;

// Swiss Post scans end in the site's six-digit number: "Zürich Briefzentrum 801050".
const FACILITIES = new Map(facilityList.map((facility) => [`${facility.country}:${facility.code}`, facility]));
// Names carriers give a hub instead of its town ("ROISSY" is Paris-Charles de Gaulle, not
// Roissy-en-Brie), and hubs in villages the gazetteer is too coarse for ("SEKOCIN STARY").
const HUBS = new Map(hubList.flatMap((hub) => hub.names.map((name) => [nameKey(name), hub])));

let loaded: Gazetteer | null = null;

function gazetteer(): Gazetteer {
  if (loaded) return loaded;
  // Parsed straight from bytes: substrings of one decompressed string would keep all 10 MB of it alive.
  const bytes = brotliDecompressSync(readFileSync(DATA));
  const rows: string[][] = [];
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(10, start);
    if (end < 0) end = bytes.length;
    const fields: string[] = [];
    for (let field = start; field <= end;) {
      let stop = bytes.indexOf(9, field);
      if (stop < 0 || stop > end) stop = end;
      fields.push(bytes.toString('utf8', field, stop));
      field = stop + 1;
    }
    rows.push(fields);
    start = end + 1;
  }
  const count = rows.filter((fields) => fields[0] === 'P').length;
  const data: Gazetteer = {
    names: [], codes: [],
    country: new Uint16Array(count), admin1: new Uint16Array(count), admin2: new Uint16Array(count),
    latitude: new Float32Array(count), longitude: new Float32Array(count), population: new Uint32Array(count),
    keys: new Map(), postcodes: new Map(), countries: new Map(), regions: new Map(), regionNames: new Map(), airports: new Map(),
  };
  const codeIndex = new Map<string, number>();
  const code = (value: string) => {
    let index = codeIndex.get(value);
    if (index === undefined) {
      index = data.codes.push(value) - 1;
      codeIndex.set(value, index);
    }
    return index;
  };
  const add = (key: string, entry: number) => {
    const existing = data.keys.get(key);
    if (existing === undefined) data.keys.set(key, entry);
    else if (typeof existing === 'number') {
      if (existing !== entry) data.keys.set(key, [existing, entry]);
    } else if (!existing.includes(entry)) existing.push(entry);
  };
  let index = 0;
  for (const fields of rows) {
    if (fields[0] === 'P') {
      const [, name, ascii, country, admin1, admin2, latitude, longitude, population, alternates] = fields;
      data.names.push(name!);
      data.country[index] = code(country!);
      data.admin1[index] = code(admin1!);
      data.admin2[index] = code(admin2!);
      data.latitude[index] = Number(latitude);
      data.longitude[index] = Number(longitude);
      data.population[index] = Number(population);
      for (const key of [...nameKeys(name!), ...(ascii ? nameKeys(ascii) : [])]) add(key, index);
      for (const key of alternates ? alternates.split(',') : []) add(key, ~index);
      index += 1;
    } else if (fields[0] === 'Z') {
      const [, country, postcode, latitude, longitude] = fields;
      data.postcodes.set(`${country}:${postcode}`, { latitude: Number(latitude), longitude: Number(longitude) });
    } else if (fields[0] === 'C') {
      const [, country, name, longitude, latitude] = fields as [string, string, string, ...string[]];
      data.countries.set(country, { name, latitude: Number(latitude), longitude: Number(longitude) });
    } else if (fields[0] === 'R') {
      const [, country, admin1, keys] = fields as [string, string, string, string];
      data.regionNames.set(`${country}.${admin1}`, keys.split(','));
      for (const key of keys.split(',')) data.regions.set(key, [...data.regions.get(key) ?? [], { country, admin1 }]);
    } else if (fields[0] === 'A') {
      const [, code, country, latitude, longitude, name, town] = fields as [string, string, string, string, string, string, string];
      data.airports.set(code, { code, country, latitude: Number(latitude), longitude: Number(longitude), name, town });
    }
  }
  loaded = data;
  return data;
}

/** Loads the gazetteer ahead of the first request that needs it. */
export function preloadPlaces(): void {
  gazetteer();
}

function distanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = Math.PI / 180;
  const a = Math.sin((latitude2 - latitude1) * radians / 2) ** 2
    + Math.cos(latitude1 * radians) * Math.cos(latitude2 * radians) * Math.sin((longitude2 - longitude1) * radians / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

interface Token { key: string; start: number; end: number }
/** Where in its field a phrase was read, and whether it is all the field says. */
interface Phrase { key: string; text: string; rank: number; start: number; end: number; whole: boolean }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].flatMap((match) => {
    if (CJK.test(match[0])) return [];
    // "BARCELONA2": a depot number glued to the town.
    const word = /\p{L}/u.test(match[0]) ? match[0].replace(/\d+$/u, '') : match[0];
    const key = nameKey(word);
    return key ? [{ key, start: match.index, end: match.index + word.length }] : [];
  });
}

/** Phrases worth looking up, most specific first: "zurich mulligen", then "zurich". */
function phrases(field: string): Phrase[] {
  const all = tokens(field).filter((token) => !/^\d+$/.test(token.key));
  const found: Phrase[] = [];
  const add = (list: Token[], rank: number, whole = false) => {
    if (!list.length) return;
    const key = list.map((token) => token.key).join(' ');
    const seen = found.find((phrase) => phrase.key === key);
    // "Guangdong" is all "Guangdong Province" says, once its administrative word is gone.
    if (seen) seen.whole ||= whole;
    else if (key.length >= 3) {
      const [start, end] = [list[0]!.start, list.at(-1)!.end];
      found.push({ key, text: field.slice(start, end), rank, start, end, whole });
    }
  };
  // Facility words alone ("Hub", "Terminal") are no town, whatever GeoNames says.
  if (all.some((token) => !FACILITY_WORDS.has(token.key))) add(all, 0, true);
  let words = all.filter((token) => !FACILITY_WORDS.has(token.key));
  while (words.length && LEADING_WORDS.has(words[0]!.key)) words = words.slice(1);
  const spans = (list: Token[], offset: number) => {
    for (let count = list.length; count > 0; count -= 1) add(list.slice(0, count), offset + list.length - count + 1, count === list.length);
    for (let start = 1; start < list.length; start += 1) add(list.slice(start), offset + list.length + start);
  };
  spans(words, 0);
  // "Zhejiang Province Jinhua City": the town without its administrative words.
  const bare = words.filter((token) => !DIVISION_WORDS.has(token.key));
  if (bare.length < words.length) spans(bare, 1);
  return [...found, ...cjkPhrases(field)];
}

/**
 * Chinese and Japanese addresses run their divisions together, each closed by its
 * suffix: "广东省深圳市宝安区" is Guangdong province, Shenzhen city, Bao'an district.
 * A facility follows its town without one: "深圳转运中心".
 */
function cjkPhrases(field: string): Phrase[] {
  const found: Phrase[] = [];
  for (const run of field.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    let start = run.index;
    run[0].split(/(?<=[省市区县都府県])/u).forEach((segment, index) => {
      const end = start + segment.length;
      const add = (key: string, rank: number) => {
        if (key.length >= 2 && !found.some((phrase) => phrase.key === key)) found.push({ key, text: segment, rank, start, end, whole: false });
      };
      const bare = segment.replace(/[省市区县都府県]$/u, '');
      add(segment, index * 2);
      add(bare, index * 2);
      for (let length = Math.min(bare.length - 1, 4); length >= 2; length -= 1) add(bare.slice(0, length), index * 2 + 3);
      start = end;
    });
  }
  return found;
}

interface Candidate {
  country: string;
  admin1: string;
  admin2: string;
  latitude: number;
  longitude: number;
  /** In thousands. */
  thousands: number;
  alternate: boolean;
  name: string;
  site?: string;
  hub?: boolean;
}

/** The places a phrase can name. A hub's name replaces the towns of its country that share it. */
function candidates(data: Gazetteer, key: string): Candidate[] {
  const hub = HUBS.get(key);
  // At its airport, or at its own point when its village is too small for the gazetteer.
  const airport = hub?.airport ? data.airports.get(hub.airport) : undefined;
  const point = airport ?? (hub?.latitude !== undefined && hub.longitude !== undefined ? { latitude: hub.latitude, longitude: hub.longitude } : undefined);
  const towns = [data.keys.get(key) ?? []].flat().flatMap((entry): Candidate[] => {
    const index = entry < 0 ? ~entry : entry;
    const country = data.codes[data.country[index]!]!;
    if (point && country === hub!.country) return [];
    return [{
      country, admin1: data.codes[data.admin1[index]!] ?? '', admin2: data.codes[data.admin2[index]!] ?? '',
      latitude: data.latitude[index]!, longitude: data.longitude[index]!, thousands: data.population[index]!,
      alternate: entry < 0, name: data.names[index]!,
    }];
  });
  if (!hub || !point) return towns;
  return [...towns, {
    country: hub.country, admin1: '', admin2: '', latitude: point.latitude, longitude: point.longitude,
    thousands: HUB_THOUSANDS, alternate: false, name: hub.town, ...(airport ? { site: airport.name } : {}), hub: true,
  }];
}

/**
 * Turns one carrier location ("ZUERICH, CH", "Härkingen 4622", "Agence DPD de
 * La Crau (283)", "Germany") into a place, or null when the text names no
 * place we can be confident about. A wrong dot is worse than no dot.
 */
export function locatePlace(location: string | null | undefined, hints: PlaceHints = {}): EventPlace | null {
  const text = location?.trim();
  if (!text) return null;
  const facility = facilityPlace(text);
  if (facility) return facility;
  const data = gazetteer();
  const explicit = trackingPlace(text);
  let country = explicit.country && data.countries.has(explicit.country) ? explicit.country : null;
  let rest = explicit.country ? explicit.place : text;
  const hinted = [...(hints.countries ?? [])];
  const admin: string[] = [];
  const postcodes: string[] = [];
  // A code that ends the text without a comma is the country, unless the town
  // before it is in a state or province of that code: "CURITIBA - PR" is Paraná.
  let looseCountry = false;

  // A trailing code without a comma ("ZUERICH CH"), or one that is also a state
  // or canton ("KOELN, DE", "Buchs SG"): a hint either way.
  const trailing = /[\s,;]+([A-Z]{2})$/.exec(rest)?.[1];
  if (!country && trailing && data.countries.has(trailing)) {
    rest = rest.slice(0, -trailing.length).replace(/[\s,;-]+$/, '');
    hinted.unshift(trailing);
    admin.push(trailing);
    if (!/,|;/.test(text.slice(0, -trailing.length)) && !ambiguousAddressCodes.has(trailing)) {
      country = trailing;
      looseCountry = true;
    }
  }
  for (const match of rest.matchAll(/\b([A-Z]{2,3})\b/g)) admin.push(match[1]!);
  for (const match of rest.matchAll(/(?:\b[A-Z]{1,2}-)?\b(\d{4,5})\b/g)) postcodes.push(match[1]!);
  // French departments and Italian provinces in brackets: "Sausheim 68 (68)", "Cologne (BS)".
  for (const match of rest.matchAll(/\((\d{2}|[A-Z]{2})\)|(?:^|\s)(\d{2})(?=\s|$)/g)) admin.push(match[1] ?? match[2]!);

  // Postcodes only confirm a name, and only in a country the scan or the parcel
  // names: on its own, "2024" is more likely a year than a village.
  const countries = country ? [country] : hinted;
  let postcode: { latitude: number; longitude: number; country: string } | null = null;
  for (const code of postcodes) {
    for (const candidateCountry of countries) {
      const entry = data.postcodes.get(`${candidateCountry}:${code}`);
      if (entry) {
        postcode = { ...entry, country: candidateCountry };
        break;
      }
    }
    if (postcode) break;
  }

  const fields = rest.split(/[,;|()]|\s+-\s+/).map((field) => field.trim()).filter(Boolean);
  const fieldPhrases = fields.map((field, index) => {
    const list = phrases(field);
    // "Frankfurt (Oder)": a town whose name has brackets of its own.
    const whole = index === 0 && rest.includes('(') ? nameKey(rest) : '';
    return whole && data.keys.has(whole) ? [{ key: whole, text: rest, rank: 0, start: 0, end: rest.length, whole: true }, ...list] : list;
  });
  // Regions named elsewhere in the text ("STERLING - Virginia - USA", "广东省深圳市") tell towns of one name apart.
  const regions = fieldPhrases.flatMap((list, field) => list.flatMap((phrase) =>
    (data.regions.get(phrase.key) ?? []).map((region) => ({ ...region, field, start: phrase.start, end: phrase.end }))));
  // The longest region name wins where two overlap: "Morona-Santiago Province" is not Santiago Province.
  const outer = regions.filter((region) => !regions.some((other) => other.field === region.field
    && other.start < region.end && other.end > region.start && other.end - other.start > region.end - region.start));

  let best: { place: Candidate; score: number; text: string; field: number } | null = null;
  for (const [fieldIndex, list] of fieldPhrases.entries()) {
    for (const phrase of list) {
      const own = data.regions.get(phrase.key) ?? [];
      // Words of a region's name are towns of that region at most: the "Delgado"
      // of "Cabo Delgado Province" is in Mozambique or nowhere.
      const around = outer.filter((region) => region.field === fieldIndex && region.start <= phrase.start
        && region.end >= phrase.end && region.end - region.start > phrase.end - phrase.start);
      const local = around.filter((region) => region.country === country || hinted.includes(region.country));
      const within = local.length ? local : around;
      // A field that only names a region is that region when it follows the town
      // ("STERLING - Virginia - USA"), or when the region is in the parcel's countries
      // ("Santa Catarina" on a Brazilian parcel).
      const named = phrase.whole ? own.filter((region) => (!country || region.country === country)
        && (fieldIndex > 0 || region.country === country || hinted.includes(region.country))) : [];
      for (const place of candidates(data, phrase.key)) {
        // A town may still be named like the region it lies in: Moscow in "…, Moscow",
        // Sofia in its own "Sofia-Capital" rather than the province of Sofia around it.
        const namesRegion = ` ${(data.regionNames.get(`${place.country}.${place.admin1}`) ?? []).join(' , ')} `.includes(` ${phrase.key} `);
        const inside = (scope: readonly Region[]) => scope.some((region) =>
          region.country === place.country && (region.admin1 === place.admin1 || namesRegion));
        // …or be the city a region is named after, wherever the line between them runs
        // ("Santo Domingo Province"); a village that shares the name is no such city.
        const namesake = (scope: readonly Region[]) => place.thousands >= NAMESAKE_THOUSANDS
          && own.some((region) => region.country === place.country
            && scope.some((other) => other.country === region.country && other.admin1 === region.admin1));
        if (within.length && !inside(within) && !namesake(within)) continue;
        if (named.length && !inside(named) && !(fieldIndex === 0 && namesake(named))) continue;
        const adminCodes = [place.admin1, place.admin2].filter(Boolean);
        const adminMatch = admin.some((code) => adminCodes.includes(code) || ADMIN_CODES[place.country]?.[code] === place.admin1)
          || regions.some((region) => region.country === place.country && region.admin1 === place.admin1
            && (region.field !== fieldIndex || region.end <= phrase.start || region.start >= phrase.end));
        const inCountry = place.country === country;
        if (country && !inCountry && !(looseCountry && adminMatch)) continue;
        const hint = hinted.indexOf(place.country);
        const postcodeMatch = postcode !== null && postcode.country === place.country
          && distanceKm(postcode.latitude, postcode.longitude, place.latitude, place.longitude) < 30;
        const confirmed = inCountry || hint >= 0 || adminMatch || postcodeMatch;
        if (!confirmed && place.thousands < UNCONFIRMED_MIN_THOUSANDS) continue;
        const score = Math.log10(Math.max(place.thousands, .3) * 1000)
          + (place.alternate ? 0 : 1.8)
          + (inCountry ? 4 : hint >= 0 ? 2.5 - Math.min(hint, 3) * .4 : 0)
          + (adminMatch ? 3 : 0) + (postcodeMatch ? 3 : 0)
          - phrase.rank * .3 - fieldIndex * .5;
        if (!best || score > best.score) best = { place, score, text: phrase.text, field: fieldIndex };
      }
    }
  }

  if (best) {
    const { place, text: written } = best;
    const airport = place.hub ? null : airportFor(data, rest, fields[best.field] ?? rest, place, written, country);
    return {
      latitude: round(airport?.latitude ?? place.latitude),
      longitude: round(airport?.longitude ?? place.longitude),
      precision: 'city',
      country: place.country,
      // Keep the carrier's spelling unless it is shouting: "La Crau", but "Köln" for "KOELN".
      name: /\p{Ll}/u.test(written) ? written : place.name,
      ...(place.site ? { site: place.site } : airport ? { site: airport.name } : {}),
    };
  }
  // A region alone places its country: "Guangdong Province", or "Santa Catarina"
  // on a Brazilian parcel, though Cape Verde has one too.
  if (!country) {
    const named = fieldPhrases.flatMap((list) => list.filter((phrase) => phrase.whole && phrase.key.length >= 4
      && !VAGUE_REGIONS.has(phrase.key)).map((phrase) => {
      const all = new Set((data.regions.get(phrase.key) ?? []).map((region) => region.country));
      const local = new Set([...all].filter((code) => hinted.includes(code)));
      return all.size > 1 && local.size ? local : all;
    }));
    country = named.find((set) => set.size === 1)?.values().next().value ?? null;
  }
  const area = country ? data.countries.get(country) : null;
  return area && country ? { latitude: area.latitude, longitude: area.longitude, precision: 'country', country, name: area.name } : null;
}

/**
 * The airport a scan names, near the town it names: by its code in brackets
 * ("Frankfurt Airport (FRA)"), by a word of its own name ("LONDON-HEATHROW"),
 * or as the one airport of the town when the text says airport ("LIEGE AIRPORT").
 * `text` is the location without the country it names, `field` the part of it
 * the town was read from: in "Soyapango, San Salvador" the region is no airport.
 */
function airportFor(data: Gazetteer, text: string, field: string, town: Candidate, written: string, country: string | null): Airport | null {
  const words = new Set(tokens(text).map((token) => token.key));
  const fieldWords = new Set(tokens(field).map((token) => token.key));
  const townWords = new Set([...nameKey(written).split(' '), ...nameKey(town.name).split(' ')]);
  const nearby = [...data.airports.values()].filter((airport) => (!country || airport.country === country)
    && distanceKm(town.latitude, town.longitude, airport.latitude, airport.longitude) <= AIRPORT_MAX_KM);
  for (const [, code] of text.matchAll(/\(([A-Z]{3})\)/g)) {
    const named = nearby.find((airport) => airport.code === code);
    if (named) return named;
  }
  const distinct = nearby.filter((airport) => nameKey(airport.name).split(' ')
    .some((word) => word.length >= 5 && !AIRPORT_NAME_WORDS.has(word) && !townWords.has(word) && fieldWords.has(word)));
  if (distinct.length === 1) return distinct[0]!;
  if (![...words].some((word) => AIRPORT_WORDS.has(word))) return null;
  const serving = nearby.filter((airport) => [...townWords].some((word) => word.length >= 3
    && ` ${nameKey(airport.name)} ${nameKey(airport.town)} `.includes(` ${word} `)));
  return serving.length === 1 ? serving[0]! : null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A sorting centre the table knows, by its number and the town its name starts with. */
function facilityPlace(text: string): EventPlace | null {
  const match = /^(.*\S)\s+(\d{6})$/.exec(text);
  const facility = match && FACILITIES.get(`CH:${match[2]}`);
  if (!facility || !`${nameKey(match[1]!)} `.startsWith(`${nameKey(facility.town)} `)) return null;
  const { latitude, longitude, country, town, name } = facility;
  return { latitude, longitude, precision: 'city', country, name: town, ...(name === town ? {} : { site: name }) };
}

/** The carrier's own point in place of the town's centre, when the two agree. */
function atPoint(place: EventPlace | null, point: EventPoint | null | undefined): EventPlace | null {
  if (!place || !point || place.precision !== 'city') return place;
  if (distanceKm(place.latitude, place.longitude, point.latitude, point.longitude) > POINT_MAX_KM) return place;
  return { ...place, latitude: point.latitude, longitude: point.longitude };
}

const cache = new Map<string, EventPlace | null>();
const CACHE_SIZE = 20_000;

function cachedPlace(location: string | null | undefined, countries: readonly string[]): EventPlace | null {
  const key = `${countries.join(',')}|${location ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  const place = locatePlace(location, { countries });
  if (cache.size >= CACHE_SIZE) cache.clear();
  cache.set(key, place);
  return place;
}

/**
 * Places for a parcel's scans, oldest first. A scan that names no country
 * borrows one from the scans around it, then the destination and the
 * carrier's home countries, so "Buchs" after "Zürich" stays in Switzerland.
 * A carrier's own point for a scan, or for another scan with the same text,
 * moves it from the town's centre to the facility, if the two are within
 * 30 km of each other.
 */
export function placesForEvents(
  locations: readonly (string | null | undefined)[],
  { destinationCountry, carrierCountries = [], points = [] }: {
    destinationCountry?: string | null;
    carrierCountries?: readonly string[];
    /** The carrier's own point for each scan, where it gave one. */
    points?: readonly (EventPoint | null | undefined)[];
  } = {},
): (EventPlace | null)[] {
  const base = [...new Set([destinationCountry, ...carrierCountries].filter((code): code is string => Boolean(code)))];
  const first = locations.map((location) => cachedPlace(location, base));
  // A carrier can place some scans of an office and not others: they all share it.
  const pointAt = new Map<string, EventPoint>();
  locations.forEach((location, index) => {
    const point = points[index];
    if (location && point && !pointAt.has(location.trim())) pointAt.set(location.trim(), point);
  });
  return locations.map((location, index) => {
    if (!location?.trim()) return null;
    const before = first.slice(0, index).reverse().find(Boolean)?.country;
    const after = first.slice(index + 1).find(Boolean)?.country;
    const neighbours = [...new Set([before, after].filter((code): code is string => Boolean(code)))];
    const place = !neighbours.length || neighbours.every((code) => base.includes(code))
      ? first[index]!
      : cachedPlace(location, [...neighbours, ...base.filter((code) => !neighbours.includes(code))]) ?? first[index]!;
    return atPoint(place, points[index] ?? pointAt.get(location.trim()));
  });
}
