/**
 * The detection engine.
 *
 * What it is: matches a tracking number against every carrier's catalog
 * detection rules and their checksums. Exactly one high-confidence match
 * selects a carrier; zero or several keep the number as a low-confidence
 * suggestion and return the candidates. It can also name the rules whose
 * failed checksum kept their carrier out of those candidates.
 * What it is not: no network lookup, no provider I/O, no carrier ranking by
 * popularity — only the rules declared in the catalog decide. A `preferred`
 * rule only moves its carrier to the front of the suggestions.
 */
import { DETECTION_RULE_IDS, type CarrierId } from '../../generated/catalog.js';
import type { DetectionRule } from '../catalog/types.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { CHECKSUMS } from './checksums.js';
import { isCttExpressTrackingNumber } from './cttExpress.js';
import { normalizeTrackingNumber } from './normalize.js';
import { compiledRule, compiledRuleFits, ruleFits, type CompiledRule } from './rules.js';
import type { CarrierDetection, ChecksumRejection } from './types.js';

function checksumPasses(rule: DetectionRule, trackingNumber: string): boolean {
  return rule.checksum === undefined || CHECKSUMS[rule.checksum](trackingNumber);
}

interface RejectedRule { carrier: CarrierId; id: string; rule: DetectionRule }

/** A carrier that declares rules, with their expressions. */
interface CarrierRules { carrier: CarrierId; rules: readonly DetectionRule[]; expressions: readonly CompiledRule[] }

/**
 * A carrier's first rule whose pattern, rawPattern and checksum all pass: it
 * decides the carrier's confidence and preference. The rules before it that
 * fit the number but failed their checksum are added to `rejected`.
 */
function decisiveRule(entry: CarrierRules, trackingNumber: string, printed: string, rejected: RejectedRule[]): DetectionRule | undefined {
  for (const [index, rule] of entry.rules.entries()) {
    if (!compiledRuleFits(entry.expressions[index]!, trackingNumber, printed)) continue;
    if (checksumPasses(rule, trackingNumber)) return rule;
    rejected.push({ carrier: entry.carrier, id: DETECTION_RULE_IDS[entry.carrier][index]!, rule });
  }
  return undefined;
}

/** Consecutive carriers of the catalog, with one expression joining every pattern of their rules. */
interface RuleGroup { carriers: readonly CarrierRules[]; anyPattern: RegExp }

// Sixteen rules to a group: few expressions to test, and few rules left
// to try one by one in a group that fits.
const RULES_PER_GROUP = 16;
let ruleGroups: RuleGroup[] | undefined;
/** A backreference counts groups, which joining patterns renumbers: such a pattern joins as one that fits anything. */
const BACKREFERENCE = /\\[1-9]|\\k</;

/**
 * Most strings a pasted text offers fit no rule. The expression joining a
 * group's patterns fits exactly when one of them does, so a group it does not
 * fit holds no carrier a rule would offer and no checksum to reject, and its
 * carriers are skipped. Carriers without rules are left out the same way.
 */
function groupsOfRules(): RuleGroup[] {
  if (ruleGroups) return ruleGroups;
  const groups: RuleGroup[] = [];
  let carriers: CarrierRules[] = [];
  let patterns: string[] = [];
  const close = () => {
    if (carriers.length > 0) groups.push({ carriers, anyPattern: new RegExp(patterns.map((pattern) => `(?:${pattern})`).join('|')) });
    carriers = [];
    patterns = [];
  };
  for (const carrier of Object.keys(CARRIER_DEFINITIONS) as CarrierId[]) {
    const rules = CARRIER_DEFINITIONS[carrier].detectionRules;
    if (rules.length === 0) continue;
    if (patterns.length > 0 && patterns.length + rules.length > RULES_PER_GROUP) close();
    carriers.push({ carrier, rules, expressions: rules.map(compiledRule) });
    patterns.push(...rules.map((rule) => BACKREFERENCE.test(rule.pattern) ? '' : rule.pattern));
  }
  close();
  ruleGroups = groups;
  return groups;
}

function detect(raw: string): { detection: CarrierDetection; rejections: ChecksumRejection[] } {
  const printed = raw.trim().toUpperCase();
  const trackingNumber = normalizeTrackingNumber(raw);
  if (!trackingNumber) {
    return { detection: { carrier: 'unknown', confidence: 'none', candidates: [], preferred: [] }, rejections: [] };
  }

  const matches: { carrier: CarrierId; confidence: 'high' | 'low'; preferred: boolean }[] = [];
  const rejected: RejectedRule[] = [];
  for (const group of groupsOfRules()) {
    if (!group.anyPattern.test(trackingNumber)) continue;
    for (const entry of group.carriers) {
      if (entry.carrier === 'ctt-express' && !isCttExpressTrackingNumber(trackingNumber)) continue;
      const rule = decisiveRule(entry, trackingNumber, printed, rejected);
      if (rule) matches.push({ carrier: entry.carrier, confidence: rule.confidence, preferred: rule.preferred === true });
    }
  }

  const highConfidence = matches.filter((match) => match.confidence === 'high');
  const ranked = highConfidence.length > 0 ? highConfidence : matches;
  // Number evidence first; catalog order otherwise.
  const preferred = ranked.filter((match) => match.preferred).map((match) => match.carrier);
  const candidates = [...preferred, ...ranked.filter((match) => !match.preferred).map((match) => match.carrier)];
  // A rule counts when passing its checksum would have listed its carrier: a
  // low-confidence rule would still be hidden by a high-confidence match.
  const rejections = rejected
    .filter(({ carrier, rule }) => !candidates.includes(carrier) && (rule.confidence === 'high' || highConfidence.length === 0))
    .map(({ carrier, id, rule }) => ({ carrier, rule: id, checksum: rule.checksum! }));
  if (highConfidence.length === 1) {
    return { detection: { carrier: highConfidence[0]!.carrier, confidence: 'high', candidates, preferred }, rejections };
  }
  return {
    detection: { carrier: 'unknown', confidence: matches.length > 0 ? 'low' : 'none', candidates, preferred },
    rejections,
  };
}

/** Return only a high-confidence carrier; preserve ambiguous candidates for the UI. */
export function detectCarrierMatch(raw: string): CarrierDetection {
  return detect(raw).detection;
}

/**
 * The detection rules whose pattern, and rawPattern on the printed input, fit
 * the number but whose checksum failed, when that kept their carrier out of
 * `detectCarrierMatch`'s candidates. A caller that later confirms one of these
 * carriers for the number has found a check that may be wrong for real numbers.
 */
export function checksumRejections(raw: string): ChecksumRejection[] {
  return detect(raw).rejections;
}

/**
 * Every rule whose pattern, and rawPattern on the printed input, fit the
 * number but whose checksum failed, whatever else matches the number. Unlike
 * `checksumRejections`, it keeps a low-confidence rule that another carrier's
 * high-confidence match hides: a carrier whose adapter applies the same check
 * refuses the number either way.
 */
export function checksumFailures(raw: string): ChecksumRejection[] {
  const printed = raw.trim().toUpperCase();
  const trackingNumber = normalizeTrackingNumber(raw);
  if (!trackingNumber) return [];
  return (Object.keys(CARRIER_DEFINITIONS) as CarrierId[]).flatMap((carrier) =>
    CARRIER_DEFINITIONS[carrier].detectionRules.flatMap((rule, index) =>
      ruleFits(rule, trackingNumber, printed) && !checksumPasses(rule, trackingNumber)
        ? [{ carrier, rule: DETECTION_RULE_IDS[carrier][index]!, checksum: rule.checksum! }] : []));
}

/** Guess only when the tracking-number shape identifies one carrier confidently. */
export function detectCarrier(raw: string): CarrierId {
  return detectCarrierMatch(raw).carrier;
}
