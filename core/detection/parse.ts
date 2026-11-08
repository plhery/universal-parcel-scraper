/**
 * Pasted-input parsing.
 *
 * What it is: turns whatever a user pastes — a bare number, a carrier link, or
 * a whole shipping message — into a tracking number plus a carrier, using the
 * catalog link rules and then the detection engine.
 * What it is not: it never fetches the pasted URL and performs no provider I/O;
 * every decision comes from the string and the catalog.
 */
import type { CarrierId } from '../../generated/catalog.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { TRACKING_LINK_RULES, matchesDomain, type TrackingLinkRule } from '../catalog/linkRules.js';
import { ALTERNATIVE_WORDS, candidateScan, keywordNumberInText, recognizedNumberInScan } from './candidates.js';
import { detectCarrierMatch } from './detect.js';
import { validTrackingNumber } from './valid.js';
import type { TrackingInputMatch } from './types.js';

function trimPastedUrl(raw: string): string {
  return raw.replace(/^[\s<'"(\x5b]+/, '').replace(/[\s>'")\],;.!?]+$/, '');
}

/** Each link rule's position in TRACKING_LINK_RULES, under every domain it names. */
let linkRulesByDomain: Map<string, number[]> | undefined;

/**
 * The link rules naming the host or a domain it belongs to, in catalog order:
 * the rules `matchesDomain` accepts, found by the host's own suffixes rather
 * than by testing every domain of the catalog.
 */
export function linkRulesForHost(host: string): TrackingLinkRule[] {
  if (!linkRulesByDomain) {
    linkRulesByDomain = new Map();
    for (const [index, rule] of TRACKING_LINK_RULES.entries()) {
      for (const domain of new Set(rule.domains)) {
        const indexes = linkRulesByDomain.get(domain);
        if (indexes) indexes.push(index);
        else linkRulesByDomain.set(domain, [index]);
      }
    }
  }
  const found = new Set(linkRulesByDomain.get(host));
  for (let dot = host.indexOf('.'); dot >= 0; dot = host.indexOf('.', dot + 1)) {
    for (const index of linkRulesByDomain.get(host.slice(dot + 1)) ?? []) found.add(index);
  }
  return [...found].sort((left, right) => left - right).map((index) => TRACKING_LINK_RULES[index]!);
}

/**
 * The most distinct links one paste reads, in the order written. An email
 * prints a few dozen; the rest of a longer list is still read as text.
 */
const MOST_PASTED_URLS = 200;

/**
 * Links printed without their scheme, as text messages and labels give them
 * ("spx.com.br/track?…"), read as https links, but only on a host a tracking
 * link rule names: any other dotted word with a slash stays text.
 */
function bareTrackingLinks(input: string): string[] {
  return (input.match(/(?<![\w@./:%-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']*/gi) ?? [])
    .map((link) => `https://${link}`)
    .filter((link) => {
      try {
        const host = new URL(trimPastedUrl(link)).hostname.toLowerCase();
        return linkRulesForHost(host).length > 0;
      } catch {
        return false;
      }
    });
}

function cleanLinkTrackingNumber(raw: string): string {
  return raw.split(/[,|]/, 1)[0]!.trim();
}

function queryParam(url: URL, names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [name, value] of url.searchParams) {
    if (wanted.has(name.toLowerCase()) && value.trim()) return value;
  }
  return undefined;
}

function numberFromRule(url: URL, rule: TrackingLinkRule): string | undefined {
  const fromQuery = rule.params ? queryParam(url, rule.params) : undefined;
  const fromBareQuery = rule.query?.exec(decodeURIComponent(url.search.slice(1)))?.[1];
  const fromPath = rule.path?.exec(url.pathname)?.[1];
  const fromFragment = rule.fragment?.exec(decodeURIComponent(url.hash.slice(1)))?.[1];
  const candidate = cleanLinkTrackingNumber(fromQuery ?? fromBareQuery ?? fromPath ?? fromFragment ?? '');
  return validTrackingNumber(candidate) ? candidate : undefined;
}

/** The rule's link covers the host of the carrier's own tracking page. */
function coversTrackingPage(rule: TrackingLinkRule, carrier: CarrierId): boolean {
  const template = CARRIER_DEFINITIONS[carrier].trackingUrlTemplate;
  if (!template) return false;
  const host = new URL(template).hostname;
  return rule.domains.some((domain) => matchesDomain(host, domain));
}

function trackingMatch(
  trackingNumber: string,
  source: TrackingInputMatch['source'],
): TrackingInputMatch {
  return { trackingNumber, source, ...detectCarrierMatch(trackingNumber) };
}

// "1234567899 or 9987654321" holds two numbers.
const ALTERNATIVE = new RegExp(`^(?:${ALTERNATIVE_WORDS})$`, 'i');
// A word naming the code after it, alone or after another word ("Pickup code").
// German and Dutch join theirs into one word: Abholcode, Sendungsnummer. French,
// Spanish, Italian and Portuguese name what the number tracks after a preposition
// ("N° de suivi", "número de seguimiento", "numero di tracciamento"), Polish
// after the word ("numer przesyłki"), and the tracking word can stand alone
// ("Suivi"), as can a courier's word for its waybill ("AWB", "Guía"). An
// abbreviated "No." can follow the label ("AWB No."). "N°", "Waybill" and
// "Tracking" can touch their digits; no carrier's number starts with those words.
const TRACKED = 'suivi|seguimiento|rastreo|tracciamento|rastreio|rastreamento|tracking|waybill|awb|guía|guia';
const LABEL = new RegExp('^(?:\\p{L}+\\s+)?(?:(?:\\p{L}*(?:code|nummer)|number|numer|numero|número|numéro|nr|n\\.?[°º]|kod|codice|codigo|código)'
  + `(?:\\s+(?:(?:de|du|del|di|do|da)\\s+(?:${TRACKED}|colis|envío|envio|spedizione)|przesyłki|paczki))?|${TRACKED})`
  + '(?:\\s+(?:no|nr)\\.)?(?:[.:#\\s]+|(?<=[°º]|waybill|tracking))(?=\\d)', 'iu');
// A label of another number: an order's, a customer's, an invoice's, a phone's or a voucher's.
const OTHER_NUMBER = /order|bestell|auftrag|commande|pedido|ordine|zam[oó]wieni|kunden|customer|client|rechnung|invoice|factur|telefon|phone|gutschein|voucher|coupon|rabatt|promo/iu;
// A word among the groups of an entry. The letters a number prints apart are
// fewer, "RR 123 456 789 FR", and GLS's lettered Track IDs stand alone.
const WORD = /(?:^|\s)\p{L}{5,}(?=\s|$)/u;
const holdsWord = (entry: string) => /\s/.test(entry) && WORD.test(entry);

/**
 * The number a short entry holds whole, groups a label prints apart included,
 * as in "1Z 999 AA1 01 2345 6784". A word offering a second number leaves it
 * unread, and a label word before the digits is no part of it, unless a
 * carrier confidently claims the two together. Nor is any other word: "Suivi
 * colis 12345678" holds no number whole. A label of an order's or a phone's
 * number names no tracking number.
 */
function numberEnteredWhole(input: string): { number: string; labelled: boolean } | undefined {
  if (input.includes('://')) return undefined;
  const alternatives = input.split(/\s+/).reduce<string[]>((groups, word) => {
    if (ALTERNATIVE.test(word)) groups.push('');
    else groups[groups.length - 1] += word;
    return groups;
  }, ['']);
  if (alternatives.filter((group) => /\d/.test(group)).length > 1) return undefined;
  const claimed = detectCarrierMatch(input).confidence === 'high';
  const label = LABEL.exec(input);
  if (label && !claimed && !OTHER_NUMBER.test(label[0])) {
    const number = input.slice(label[0].length);
    if (validTrackingNumber(number) && !holdsWord(number)) return { number, labelled: true };
  }
  return validTrackingNumber(input) && (claimed || !holdsWord(input)) ? { number: input, labelled: false } : undefined;
}

/**
 * Pull a tracking number and carrier out of a number, carrier URL, or pasted
 * shipping message. Number shape disambiguates links shared by multiple brands,
 * a link to the host of another carrier's tracking page names that carrier for
 * a number only it issues, and a link marked `ownNumbersOnly` names its
 * carrier only for that carrier's own numbers.
 */
export function parseTrackingInput(raw: string): TrackingInputMatch {
  const input = raw.trim();
  if (!input) {
    return {
      trackingNumber: '',
      carrier: 'unknown',
      confidence: 'none',
      candidates: [],
      preferred: [],
      source: 'none',
    };
  }

  // A link met again reads as it did the first time, and a candidate met again was no carrier's.
  const pastedUrls = [...new Set([...input.match(/https?:\/\/[^\s<>"']+/gi) ?? [], ...bareTrackingLinks(input)])].slice(0, MOST_PASTED_URLS);
  const scan = candidateScan();
  for (const pastedUrl of pastedUrls) {
    const trackingUrl = trimPastedUrl(pastedUrl);
    try {
      const url = new URL(trackingUrl);
      const rules = linkRulesForHost(url.hostname.toLowerCase()).filter((candidate) =>
        !candidate.pathPattern || candidate.pathPattern.test(url.pathname));
      // The longer matching domain comes first, then a rule bound to a path on it.
      const specificity = (rule: TrackingLinkRule) => Math.max(...rule.domains.filter((domain) => matchesDomain(url.hostname.toLowerCase(), domain)).map((domain) => domain.length));
      rules.sort((a, b) => specificity(b) - specificity(a) || Number(Boolean(b.pathPattern)) - Number(Boolean(a.pathPattern)));
      for (const firstRule of rules) {
        const trackingNumber = numberFromRule(url, firstRule);
        if (trackingNumber) {
          const detected = detectCarrierMatch(trackingNumber);
          const suggestedRules = rules.filter((candidate) => detected.candidates.includes(candidate.carrier));
          const suggestedCarriers = new Set(suggestedRules.map((candidate) => candidate.carrier));
          if (firstRule.detectFromNumber && (detected.confidence === 'high'
            || (detected.confidence === 'low' && suggestedCarriers.size > 1))) {
            return { trackingNumber, ...detected, source: 'link' };
          }
          const rule = detected.confidence === 'high'
            ? rules.find((candidate) => candidate.carrier === detected.carrier) ?? firstRule
            : suggestedCarriers.size === 1 ? suggestedRules[0]! : firstRule;
          if (rule.ownNumbersOnly && !detected.candidates.includes(rule.carrier)) {
            return { trackingNumber, ...detected, source: 'link' };
          }
          // A host that is also the number's carrier's tracking page, as Royal Mail's is Parcelforce's, names that carrier.
          const carrier = detected.confidence === 'high' && coversTrackingPage(rule, detected.carrier)
            ? detected.carrier
            : rule.carrier;
          return {
            trackingNumber,
            carrier,
            confidence: 'high',
            candidates: [carrier],
            preferred: [],
            trackingUrl: rule.keepsCapabilityUrl ? trackingUrl : undefined,
            source: 'link',
          };
        }
      }

      const trackingNumber = recognizedNumberInScan(decodeURIComponent(url.href), scan);
      if (trackingNumber) return trackingMatch(trackingNumber, 'link');
    } catch {
      // Keep looking: pasted prose can contain a truncated or malformed URL.
    }
  }

  const recognized = recognizedNumberInScan(input, scan);
  if (recognized) {
    return trackingMatch(recognized, input === recognized ? 'number' : 'text');
  }

  // An entry that holds its number whole keeps the groups it prints apart: "Sendungsnummer 0034 0434 …".
  const whole = numberEnteredWhole(input);
  if (whole) return trackingMatch(whole.number, whole.labelled ? 'text' : 'number');

  const keywordNumber = keywordNumberInText(input);
  if (keywordNumber) return trackingMatch(keywordNumber, 'text');

  return {
    trackingNumber: '',
    carrier: 'unknown',
    confidence: 'none',
    candidates: [],
    preferred: [],
    source: 'none',
  };
}
