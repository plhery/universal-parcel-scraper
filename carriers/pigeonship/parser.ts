import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { pigeonshipStage } from './status.js';

export const CARRIER = 'pigeonship';
export const PROVIDER = 'PigeonShip';
// The page is about 45 kB; every other stop on the driver's route adds a line.
export const PIGEONSHIP_MAX_BYTES = 1024 * 1024;
const PAGE = 'https://admin.pigeonship.com/shipping/tracking/package/';

/** A number for PigeonShip's tracking page, in capitals: one token of letters and digits. */
export function normalizePigeonshipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{8,30}$/.test(number)) throw new InvalidInputError(PROVIDER, 'PigeonShip numbers are eight to thirty letters and digits');
  return number;
}

/** The tracking page the recipient's link opens, with the number in its path. */
export function pigeonshipUrl(number: string): string {
  return `${PAGE}${encodeURIComponent(number)}/`;
}

// The site's page for a path it has nothing at, an unknown number's included.
const MISSING = /<title>\s*Page not found\s*<\/title>/;
const SHOWN = /Thank you for choosing PigeonShip\.[^<]{0,200}?Tracking number\s+([^<\s]{1,64})\s*<\/div>/;
// The page's Vue data: the order's fields, then the other stops on the route, which are not read.
const ORDER = /el:\s*'#live-tracking'[\s\S]{0,4000}?\border:\s*\{([^{}]{0,2000})\}/;
const ESCAPE = /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g;

/** A single-quoted JavaScript string's value, as Django's escapejs writes it. */
function scriptString(literal: string): string {
  return literal.replace(ESCAPE, (_, unicode?: string, hex?: string, other?: string) => {
    const code = unicode ?? hex;
    return code ? String.fromCharCode(Number.parseInt(code, 16)) : other!;
  });
}

/** The deliver-by instant, or none when the order has no due date. */
function dueBy(order: string): string | null {
  const literal = /\bdueDate:\s*(?:new Date\('([^']{0,40})'\)|null)/.exec(order);
  const value = literal?.[1];
  if (!value || value === 'None') return null;
  const instant = explicitOffsetTime(value);
  if (!instant) throw new SchemaError(PROVIDER, 'PigeonShip returned an invalid due date');
  return instant.iso;
}

/**
 * PigeonShip's tracking page for one number, rendered on its server: the order's status code
 * and label, whether it is delivered and when it is due, with no scan history.
 */
export function parsePigeonshipPage(status: number, page: string, raw: string): CarrierResult {
  const number = normalizePigeonshipNumber(raw);
  if (status === 404) {
    if (MISSING.test(page.slice(0, 64_000))) throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'PigeonShip answered 404 without its own page', { status });
  }
  const shown = SHOWN.exec(page)?.[1];
  const order = ORDER.exec(page)?.[1];
  if (shown === undefined || order === undefined) throw new SchemaError(PROVIDER, 'PigeonShip returned a page without its tracking section');
  if (shown.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'PigeonShip answered for another number');

  const code = /\bstatus:\s*(\d{1,4})\s*,/.exec(order)?.[1];
  const delivered = /\bdelivered:\s*(true|false)\s*,/.exec(order)?.[1];
  const label = /\bstatusDisplay:\s*'((?:[^'\\]|\\.){0,200})'/.exec(order)?.[1];
  if (code === undefined || delivered === undefined || label === undefined) throw new SchemaError(PROVIDER, 'PigeonShip returned an order without its status');
  const stage = delivered === 'true' ? 'delivered' : pigeonshipStage(code);
  const due = dueBy(order);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: clean(scriptString(label), 200) || (stage === 'delivered' ? 'Delivered' : ''),
    provider_code: code,
    last_update: null,
    expected_delivery: stage === 'delivered' ? null : due,
    summary_only: true,
    events: [],
  };
}
