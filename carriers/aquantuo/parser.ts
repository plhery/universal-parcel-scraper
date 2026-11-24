import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { aquantuoStage } from './status.js';

export const PROVIDER = 'Aquantuo';
// Bot checks Cloudflare puts in place of the page.
export const AQUANTUO_CHALLENGE = /_cf_chl_opt|cf-turnstile|cf-error-details|<title>\s*Just a moment|<title>\s*Attention Required/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "Apr 22, 2026 07:40 AM": a step's date and clock.
const CLOCK = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}) (\d{1,2}):([0-5]\d) ?(AM|PM)$/i;
// "30 Apr, 2026": the expected delivery day.
const DAY = /^(\d{1,2}) ([A-Za-z]{3}),? (\d{4})$/;
const MAX_ROWS = 200;

/** A tracking or item id: letters and digits. */
export function normalizeAquantuoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!/^[A-Z0-9]{6,32}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Aquantuo tracking ids are 6 to 32 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const monthOf = (name: string) => MONTHS.indexOf(name.toLowerCase()) + 1;

function clockOf(text: string): string {
  const clock = CLOCK.exec(text);
  const day = clock ? calendarDay(Number(clock[3]), monthOf(clock[1]!), Number(clock[2])) : null;
  if (!clock || !day || Number(clock[4]) === 0 || Number(clock[4]) > 12) return invalid('Aquantuo returned an invalid step clock');
  const hour = Number(clock[4]) % 12 + (clock[6]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${day}T${String(hour).padStart(2, '0')}:${clock[5]}:00`;
}

/**
 * Reads the tracking page for one id. The page gives each step's name, a message it writes when
 * it renders and a clock without a zone; the steps keep their names and wall clocks.
 */
export function parseAquantuo(html: string, number: string): CarrierResult {
  if (AQUANTUO_CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Aquantuo answered with a browser check');
  const $ = load(html);
  const asked = $('form#search_form_id input[name="package_id"]').attr('value');
  if (asked === undefined) return invalid('Aquantuo returned an unknown page');
  // The page names the id only in its search box.
  if (clean(asked, 80).toUpperCase().replace(/[\s-]/g, '') !== number) throw new IndeterminateError(PROVIDER, 'Aquantuo answered for another id');
  const card = $('.to-status-card');
  const items = $('.to-history-item').toArray();
  // An id the site does not hold gets the search box back alone.
  if (!card.length && !items.length) throw new NotFoundError(PROVIDER, 'Aquantuo has no package for this id');
  if (items.length > MAX_ROWS) return invalid('Aquantuo returned too many steps');

  const events: CarrierEvent[] = items.map(item => {
    const name = clean($(item).find('.to-history-status').text(), 200);
    if (!name) return invalid('Aquantuo returned a step without its name');
    const stage = aquantuoStage(name);
    return { local_time: clockOf(clean($(item).find('.to-history-date').text(), 60)), description: name, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  const current = clean(card.find('.to-status-left .to-status-value').text(), 200);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Aquantuo lists the package without its steps', { reason: 'listed' });

  const staged = events.find(event => event.stage);
  const expected = DAY.exec(clean(card.find('.to-status-date').text(), 40));
  const done = staged?.stage === 'delivered' || staged?.stage === 'exception';
  const day = expected && !done ? calendarDay(Number(expected[3]), monthOf(expected[2]!), Number(expected[1])) : null;
  return {
    status: staged ? languageStageStatus(staged.stage as Stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: current || events[0]!.description || null,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: day ?? null,
    events,
  };
}
