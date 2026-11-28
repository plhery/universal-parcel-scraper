import { townName } from '../core/time/townNames.js';
import countryData from './countries.json' with { type: 'json' };
import subdivisionData from './subdivisions.json' with { type: 'json' };

const regionCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
/** Each country's ISO 3166-2 codes of two letters, former ones included (`scripts/generate-subdivisions.mjs`). */
const subdivisions = new Map(Object.entries(subdivisionData.regions).map(([country, codes]) => [country, new Set(codes.split(' '))]));
const subdivisionOf = (country: string, code: string): boolean => subdivisions.get(country)?.has(code) ?? false;
/** How a code follows the town: "TOWN (XX)" or "TOWN [XX]", "TOWN, XX", "TOWN - XX" or "TOWN/XX", "TOWN XX". */
type CodeForm = 'bracket' | 'comma' | 'dash' | 'space';
// The forms in which a country's addresses write a region's code after the town: US, Canadian and Australian states
// after a comma, a dash or in brackets ("Hebron, KY"), Swiss cantons after a comma, a space or in brackets ("Buchs AG"),
// Italian provinces in brackets ("BENTIVOGLIO (BO)") and Brazilian states after a dash, a slash or a comma
// ("CURITIBA - PR"). Other countries' addresses write no region's code, so theirs keep naming countries: "Shenzhen, CN"
// on a parcel to Spain is not in the Canaries, nor "Bruxelles, BE" on a parcel to Germany in Berlin.
const REGION_FORMS: Readonly<Record<string, readonly CodeForm[]>> = {
  US: ['comma', 'dash', 'bracket'], CA: ['comma', 'dash', 'bracket'], AU: ['comma', 'dash', 'bracket'],
  CH: ['comma', 'bracket', 'space'], IT: ['bracket'], BR: ['comma', 'dash'],
};
// With nothing known of the parcel, a code these countries' regions share names no country after a comma or in
// brackets ("Wilmington, DE", "Basel, BS", "TORINO (TO)"): the region is as likely.
const UNKNOWN_PARCEL_FORMS: Readonly<Record<string, readonly CodeForm[]>> = {
  US: ['comma', 'bracket'], CA: ['comma', 'bracket'], AU: ['comma', 'bracket'], CH: ['comma', 'bracket'], IT: ['bracket'],
};
const unknownParcelRegion = (code: string, form: CodeForm): boolean =>
  Object.entries(UNKNOWN_PARCEL_FORMS).some(([country, forms]) => forms.includes(form) && subdivisionOf(country, code));
/** Country codes that are also US, Canadian or Australian states or Swiss cantons ("Hebron, KY", "Buchs AG"). */
export const ambiguousAddressCodes: ReadonlySet<string> = new Set([...regionCodes].filter((code) => unknownParcelRegion(code, 'comma')));

/** What a scan's closing code is read against. */
export interface PlaceContext {
  /** The country a gazetteer placed the scan's town in: a code of one of its regions names it, however it follows the town. */
  placed?: string | null;
  /** The countries the parcel may be in: its origin and destination, its carriers' home countries, its other scans'. */
  countries?: readonly (string | null | undefined)[];
}

interface ClosingCode { code: string; form: CodeForm }
/** The two capital letters a location closes with, and how they follow the town. */
function closingCode(text: string): ClosingCode | null {
  const match = /\S(?:\s*\(\s*([A-Z]{2})\s*\)|\s*\[\s*([A-Z]{2})\s*\]|\s*[,;|]\s*([A-Z]{2})|(?:\s+-\s*|\s*\/\s*)([A-Z]{2})|\s+([A-Z]{2}))$/.exec(text);
  if (!match) return null;
  const [, round, square, comma, dash, space] = match;
  const bracket = round ?? square;
  return bracket ? { code: bracket, form: 'bracket' } : comma ? { code: comma, form: 'comma' }
    : dash ? { code: dash, form: 'dash' } : { code: space!, form: 'space' };
}

/**
 * The country a code after a town names, or null for none. A region's code of the country the town was placed in names
 * that country. Else a region's code of one of the parcel's countries, written as that country's addresses write it,
 * names that country ("BENTIVOGLIO (BO)" on a parcel in Italy, "CURITIBA - PR" in Brazil), and a country's code after a
 * comma or in brackets names that country; a code that can be either, or a region of two of them, names none. With
 * nothing known of the parcel, a code a US, Canadian or Australian state, a Swiss canton or an Italian province in
 * brackets shares names none. A code after a space or a dash names a country only as a region's.
 */
function codeCountry({ code, form }: ClosingCode, { placed, countries = [] }: PlaceContext): string | null {
  if (placed && (code === placed || subdivisionOf(placed, code))) return placed;
  const known = [...new Set(countries.filter((country): country is string => Boolean(country)))];
  const owners = known.filter((country) => REGION_FORMS[country]?.includes(form) && subdivisionOf(country, code));
  const written = (form === 'comma' || form === 'bracket') && regionCodes.has(code);
  if (written && known.includes(code)) return owners.length ? null : code;
  if (owners.length) return owners.length === 1 ? owners[0]! : null;
  return written && (known.length > 0 || Boolean(placed) || !unknownParcelRegion(code, form)) ? code : null;
}

// Carrier spellings no region name matches. Display only: Passport evidence
// takes a country's code, or a name the runtime gives it.
const carrierSpellings = new Map([
  ['united states of america', 'US'], ['great britain', 'GB'], ['great britain and northern ireland', 'GB'],
  ['united kingdom of great britain and northern ireland', 'GB'], ['czech republic', 'CZ'], ['holland', 'NL'],
  ['mainland china', 'CN'], ["people's republic of china", 'CN'],
  // German "Volksrepublik China", which DHL writes "China VR".
  ['volksrepublik china', 'CN'], ['vr china', 'CN'], ['china vr', 'CN'],
  ['hong kong', 'HK'], ['macau', 'MO'], ['macao', 'MO'], ['turkey', 'TR'], ['russian federation', 'RU'],
  ['korea', 'KR'], ['republic of korea', 'KR'],
]);
// DHL Express's own country names, after the article and any bracket are dropped.
const dhlSpellings = new Map([
  ['hong kong sar, china', 'HK'], ['macau sar, china', 'MO'], ['macao sar, china', 'MO'], ['china mainland', 'CN'],
  ['china, peoples republic', 'CN'], ['korea, republic of', 'KR'],
  ['ireland, republic of', 'IE'],
]);
// A state's official name: "Republic of Moldova", "Federal Republic of Germany", "Kingdom of the Netherlands",
// one with its form last, "Hellenic Republic", or the form after its short name ("KOREA, REPUBLIC OF").
// The short name after "of" is the country, unless two states share it: "Democratic People's Republic of
// Korea", "Republic of China".
const STATE_FORM = /^((?:\S+\s+)*)(?:republic|kingdom|federation|confederation|principality|sultanate)(\s+of(?:\s+(?:the\s+)?(.+))?)?$/;
const sharedShortNames = new Set(['korea', 'china', 'congo']);
// Apple's ICU (Safari, iOS) calls CN "China mainland" in every language; carriers write "China".
const chinaNames = new Map([['en', 'China'], ['de', 'China'], ['fr', 'Chine'], ['it', 'Cina'], ['es', 'China'], ['pt', 'China'], ['pl', 'Chiny'], ['uk', 'Китай']]);
// "Mexico City" is a city, not Mexico followed by one.
const settlementWords = new Set(['city', 'town', 'ville', 'stadt', 'ciudad', 'cidade', 'citta']);
// A US military post office: the Army, Fleet or Diplomatic Post Office ("APO, AE 09001",
// "FPO AP") of the Armed Forces Americas, Europe or Pacific.
const MILITARY_POST_OFFICE = /(?:^|[\s,;|(])[ADF]PO[\s,;]+A[AEP](?:\s+\d{5}(?:-\d{4})?)?$/i;
const normalized = (value: string) => value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
let countryNames: Map<string, string> | undefined;
const displayNames = new Map<string, Intl.DisplayNames>();

function namedCountry(name: string, display: boolean): string | null {
  if (!countryNames) {
    // Chinese posts also name Taiwan as part of China, or in its formal characters, which Intl does not.
    countryNames = new Map([['usa', 'US'], ['uk', 'GB'], ['中国台湾', 'TW'], ['中國台灣', 'TW'], ['中國臺灣', 'TW'], ['臺灣', 'TW']]);
    // Ukrposhta names countries in Ukrainian ("КИТАЙ", "Україна"), Chinese posts in Chinese ("日本").
    for (const language of ['en', 'de', 'fr', 'it', 'es', 'pt', 'pl', 'uk', 'zh', 'zh-Hant', 'ja']) {
      const names = new Intl.DisplayNames([language], { type: 'region' });
      for (const code of regionCodes) {
        const name = names.of(code) ?? code;
        // A name a large town shares ("Granada") names the town as often as the country.
        if (language === 'en' || !townName(name)) countryNames.set(normalized(name), code);
      }
    }
    for (const name of chinaNames.values()) countryNames.set(normalized(name), 'CN');
  }
  const key = normalized(name);
  const code = countryNames.get(key);
  if (code || !display) return code ?? null;
  const bare = key.replace(/^the /, '');
  const short = STATE_FORM.exec(bare)?.[3];
  const official = short && !sharedShortNames.has(short) ? countryNames.get(short) ?? carrierSpellings.get(short) : undefined;
  return countryNames.get(bare) ?? carrierSpellings.get(bare) ?? official ?? null;
}

/**
 * Whether a field has the form of a state's official name, read or not: "Hellenic Republic",
 * "Republic of China". "Republic" alone and "Kingdom City" are towns.
 */
export function stateFormName(field: string): boolean {
  const form = STATE_FORM.exec(normalized(field).replace(/^the /, ''));
  return Boolean(form && (form[1] || form[2]));
}

/**
 * Whether a location is a US military post office ("Fpo, AE", "APO AP 96001").
 * Its base can be anywhere in the region the code names (Europe's also covers
 * Africa, the Middle East and Canada), so it names no country: AE there is not
 * the United Arab Emirates.
 */
export function militaryPostOffice(location: string): boolean {
  return MILITARY_POST_OFFICE.test(location.trim());
}

/**
 * The country a field names: a code by `codeCountry`, a country's code written alone by itself, else a country's name
 * ("UK" is no country's code).
 */
function fieldCountry(field: string, location: string, display: boolean, context: PlaceContext, form: CodeForm): string | null {
  if (/^[A-Z]{2}$/.test(field) && location !== field) {
    const country = codeCountry({ code: field, form }, context);
    if (country || regionCodes.has(field)) return country;
  }
  return regionCodes.has(field) ? field : namedCountry(field, display);
}

/**
 * Passport evidence: only an explicit final country field, or a region's code where `context` says whose; never a
 * country inferred from a city. See `codeCountry` for codes.
 */
export function trackingLocationCountry(location?: string | null, context: PlaceContext = {}): string | null {
  const text = location?.trim();
  // Square brackets set a field apart as round ones do: "EXAMPLE TOWN [France]", "…, 00000, [US]".
  const field = text?.split(/[,;|()[\]]/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (!field || militaryPostOffice(text!)) return null;
  const closing = closingCode(text!);
  // A region's code after a dash or a space ("CURITIBA - PR", "Buchs AG").
  const region = closing && (closing.form === 'dash' || closing.form === 'space') ? codeCountry(closing, context) : null;
  return region ?? fieldCountry(field, text!, false, context, closing?.form === 'bracket' ? 'bracket' : 'comma');
}

export interface TrackingPlace {
  /** The country the carrier wrote, as an ISO 3166-1 alpha-2 code. */
  country: string | null;
  /** The rest of the location; empty when the country was all of it. */
  place: string;
}

/** The country DHL Express ends its locations with: "UK", "NETHERLANDS, THE", "HONG KONG SAR, CHINA". */
function dashCountry(part: string): string | null {
  const name = normalized(part).replace(/\s*\(.*\)$/, '').replace(/^the |, the$/g, '');
  // Also a US state: "ATLANTA - GEORGIA" is not in the Caucasus.
  if (name === 'georgia') return null;
  return dhlSpellings.get(name) ?? namedCountry(name, true);
}

/**
 * For display, take an explicit country off a location: the final field ("Zürich, CH",
 * repeated in "Hebron, KY, US, US", or in brackets, "EXAMPLE TOWN [France]"), the name after the last dash ("SCARBOROUGH - ON -
 * CANADA") or a leading name ("Switzerland Haerkingen"). A region's code read against
 * `context` gives its country and stays in the place ("BENTIVOGLIO (BO)" on a parcel in Italy).
 */
export function trackingPlace(location: string, context: PlaceContext = {}): TrackingPlace {
  const text = location.trim();
  if (militaryPostOffice(text)) return { country: null, place: text };
  const dashed = /^(.*\S)\s+-\s+(.+)$/.exec(text);
  const dashedCountry = dashed ? dashCountry(dashed[2]!) : null;
  if (dashedCountry) return { country: dashedCountry, place: dashed![1]! };
  // A country's code before a dot, as CNE writes its facilities: "CN.CNE East China Sort Facility" is in
  // China, not in East China, Michigan. "ST.LOUIS" and "PT.ELIZABETH" abbreviate Saint and Port.
  const prefixed = /^([A-Z]{2})\.(\p{L}.*)$/u.exec(text);
  if (prefixed && regionCodes.has(prefixed[1]!) && !ambiguousAddressCodes.has(prefixed[1]!) && !/^[SP]T$/.test(prefixed[1]!)) {
    return { country: prefixed[1]!, place: prefixed[2]!.trim() };
  }
  const fields = [...text.matchAll(/[^,;|()[\]]+/g)].filter((match) => match[0].trim());
  // A code alone between empty fields is alone (",,,DE"). One a state or canton shares is the
  // country another field names, which stays the place: "HOLLAND, NL" is not in Newfoundland,
  // and "Luxembourg, LU" is the city.
  const alone = fields.length === 1 ? fields[0]![0].trim() : text;
  const named = new Set(fields.map((field) => field[0].trim()).filter((field) => !regionCodes.has(field))
    .map((field) => namedCountry(field, true)));
  let country: string | null = null;
  let kept = fields.length;
  while (kept > 0) {
    const { 0: written, index } = fields[kept - 1]!;
    const field = written.trim();
    const own = fieldCountry(field, alone, true, context, text[index - 1] === '(' || text[index - 1] === '[' ? 'bracket' : 'comma');
    const code = own ?? (regionCodes.has(field) && named.has(field) ? field : null);
    if (!code || (country && code !== country)) break;
    country = code;
    // A region's code stays with its town: "BENTIVOGLIO (BO)" is in Italy.
    if (own && own !== field && subdivisionOf(own, field)) break;
    kept -= 1;
    if (!own) break;
  }
  if (country) {
    const place = kept === fields.length ? text : kept ? text.slice(0, fields[kept]!.index).replace(/[\s,;|([]+$/u, '') : '';
    return { country, place };
  }
  // A code after a dash or a space: a region's stays with its town ("CURITIBA - PR"), the country's own goes ("MILANO IT").
  const closing = closingCode(text);
  const region = closing && (closing.form === 'dash' || closing.form === 'space') ? codeCountry(closing, context) : null;
  if (region) return { country: region, place: region === closing!.code ? text.slice(0, -2).replace(/[\s/-]+$/u, '') : text };
  // A partner's depot abroad, by its country and number, as BRT writes one: "SPAIN (12)".
  const depot = /^([^,;|()]+?)\s*\(\d+\)$/u.exec(text);
  const depotCountry = depot ? namedCountry(depot[1]!, true) : null;
  if (depotCountry) return { country: depotCountry, place: '' };
  if (fields.length === 1 && text === fields[0]![0]) {
    // Aggregators can name a DHL country operation instead of a town.
    const operation = /^DHL\s+(.+)$/i.exec(text);
    const operationCountry = operation ? namedCountry(operation[1]!, true) : null;
    if (operationCountry) return { country: operationCountry, place: '' };
    const words = text.split(/\s+/);
    for (let count = Math.min(words.length - 1, 4); count > 0; count -= 1) {
      const code = namedCountry(words.slice(0, count).join(' '), true);
      const place = words.slice(count).join(' ');
      // "Mexico City" and "Panama City FL" are towns; "JAMAICA NY" is in Queens.
      const next = words[count]!;
      if (code && /^\p{Lu}/u.test(place) && !settlementWords.has(normalized(next)) && !/^[A-Z]{2}$/.test(next)) return { country: code, place };
    }
  }
  return { country: null, place: text };
}

/** A parcel's scan, as `trackingLocationCountries` reads it. */
export interface TrackingScan {
  location?: string | null;
  /** When it happened, as an ISO 8601 time or milliseconds. */
  time?: string | number | null;
  /** The country a gazetteer placed its town in. */
  placed?: string | null;
  /** A country the carrier gave in a field of its own: it stands, whatever the text says. */
  country?: string | null;
}

export interface TrackingScanCountry {
  /** Passport evidence of the scan's country, as `trackingLocationCountry` reads it. */
  country: string | null;
  /** The country the text names that the parcel could not have reached and left in the time between its neighbours. */
  implausible?: string;
}

const labelPoints = new Map(countryData.countries.map(({ code, label }) => [code, label]));
/** Great-circle kilometres between two countries' label points (Natural Earth), or null without one. */
function countryDistance(from: string, to: string): number | null {
  const [a, b] = [labelPoints.get(from), labelPoints.get(to)];
  if (!a || !b) return null;
  const radians = Math.PI / 180;
  const [longitude, latitude] = [(b[0]! - a[0]!) * radians, (b[1]! - a[1]!) * radians];
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(a[1]! * radians) * Math.cos(b[1]! * radians) * Math.sin(longitude / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
// Between scans in two countries, a parcel needs an hour's handling and flies no faster than an airliner; a label point
// can lie this far inside its country, so neighbours' scans are never too far apart.
const HANDLING_HOURS = 1;
const AIRLINER_KMH = 900;
const LABEL_SLACK_KM = 1_000;
const reachable = (kilometres: number, hours: number) => hours >= HANDLING_HOURS + Math.max(0, kilometres - LABEL_SLACK_KM) / AIRLINER_KMH;

/**
 * Passport evidence for a parcel's scans, oldest first. Each scan's text is read by `trackingLocationCountry` against
 * the town's country, the parcel's `countries` (origin, destination, carriers' home countries) and the countries of
 * the scans around it, so "EXAMPLE TOWN (BO)" between scans in Italy is in Italy. A country's code after a comma or
 * in brackets that is also a region's code of the country the scans on either side agree on ("EXAMPLE TOWN, BO" between
 * scans in Italy) is dropped when the parcel could not have flown there and back in the time between them
 * (`implausible` holds it); the town keeps its place. A country the carrier gave in a field of its own stands.
 */
export function trackingLocationCountries(scans: readonly TrackingScan[], countries: readonly (string | null | undefined)[] = []): TrackingScanCountry[] {
  const nearest = (read: readonly (string | null)[], index: number, step: -1 | 1): number => {
    for (let at = index + step; at >= 0 && at < read.length; at += step) if (read[at]) return at;
    return -1;
  };
  const alone = scans.map((scan) => scan.country || trackingLocationCountry(scan.location, { placed: scan.placed, countries }) || scan.placed || null);
  const read = scans.map((scan, index) => {
    const around = [nearest(alone, index, -1), nearest(alone, index, 1)].map((at) => alone[at] ?? null);
    const read = scan.country || trackingLocationCountry(scan.location, { placed: scan.placed, countries: [...countries, ...around] });
    // Scans on either side that agree settle a code that could be either: "EXAMPLE TOWN (BO)" between stops in
    // Bolivia is there, on a parcel from Italy.
    const agreed = !read && around[0] && around[0] === around[1] ? around[0] : null;
    return agreed && trackingLocationCountry(scan.location, { placed: scan.placed, countries: [agreed] }) === agreed ? agreed : read;
  });
  const located = read.map((country, index) => country ?? scans[index]!.placed ?? null);
  const times = scans.map(({ time }) => typeof time === 'number' ? time : time ? Date.parse(time) : Number.NaN);
  return read.map((country, index) => {
    const scan = scans[index]!;
    if (!country || scan.country || country === scan.placed) return { country };
    const [before, after] = [nearest(located, index, -1), nearest(located, index, 1)];
    const neighbour = before >= 0 ? located[before]! : null;
    // Only a code that is also a region of the neighbours' country: the reading that could be wrong.
    const closing = closingCode(scan.location?.trim() ?? '');
    if (!neighbour || after < 0 || located[after] !== neighbour || neighbour === country || closing?.code !== country
      || (closing.form !== 'comma' && closing.form !== 'bracket') || !subdivisionOf(neighbour, country)) return { country };
    const kilometres = countryDistance(neighbour, country);
    const hours = [times[index]! - times[before]!, times[after]! - times[index]!].map((ms) => ms / 3_600_000);
    if (kilometres === null || hours.some((value) => !Number.isFinite(value)) || hours.every((value) => reachable(kilometres, value))) {
      return { country };
    }
    return { country: null, implausible: country };
  });
}

export function countryFlag(code: string): string {
  return [...code].map((letter) => String.fromCodePoint(letter.charCodeAt(0) + 127397)).join('');
}

/** The region's name, with the short "Hong Kong" and "Macao" iOS also uses. */
export function countryName(code: string, languageTag: string): string {
  const china = code === 'CN' ? chinaNames.get(languageTag.split('-')[0]!) : undefined;
  if (china) return china;
  const style = code === 'HK' || code === 'MO' ? 'short' : 'long';
  const key = `${languageTag}:${style}`;
  if (!displayNames.has(key)) displayNames.set(key, new Intl.DisplayNames([languageTag], { type: 'region', style }));
  return displayNames.get(key)!.of(code) ?? code;
}
