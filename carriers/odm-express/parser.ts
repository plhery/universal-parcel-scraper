import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { odmStage } from './status.js';

export const PROVIDER = 'ODM Express';
// The page is about seventy kilobytes of WordPress around the result.
export const ODM_MAX_BYTES = 1024 * 1024;

// A guide is a letter and its serial. The page's examples have seven digits; the scanned
// receipt it links pads the serial to nine, and the tracker answers either form.
const GUIDE = /^[A-Z]\d{5,9}$/;
const HEADINGS = 'GUIA|FECHA|HORA|OBSERVACIONES';
const DAY = /^(\d{4})-(\d{2})-(\d{2}) 00:00:00$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const NOT_FOUND = /El número de guía (\S+) no existe o es incorrecto/;
const MAX_ROWS = 200;
// Bot checks a firewall or CDN could put in place of the page.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// The internal references of the bus or route a row put the guide on: "[Guia: 21974]", "[Guia Paq.: 18427]".
const REFERENCE = /\[\s*Gu[ií]a(?:\s+Paq\.)?\s*:\s*\d+\s*\]\s*:?/gi;
// Where a row goes on to name a person: the employee who documented the guide, the
// courier on the round, and whoever took the delivery, after its day.
const PERSON = /\s+POR\s+USUARIO\b|,?\s*MENSAJERO\s*:|,?\s*(?:\d{2}\/\d{2}\/\d{4}\s+)?RECIBI[OÓ]\s*:/i;
// "RECIBIDA EN : CEDIS LEON, GTO, ORIGEN : CEDIS VALLEJO": the centre that received it.
const RECEIVED = /^RECIBIDA EN\s*:\s*(.+?)\s*,?\s*(?:ORIGEN\s*:.*)?$/i;

/** The guide as the tracker takes it: a letter and five to nine digits. */
export function normalizeOdmGuide(raw: string): string {
  const guide = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!GUIDE.test(guide)) throw new InvalidInputError(PROVIDER, 'ODM Express guides are a letter and five to nine digits');
  return guide;
}

/** A row's wording without the route references it carries or the people it names. */
export function odmWording(observation: string): string {
  const text = observation.replace(REFERENCE, ' ');
  const person = PERSON.exec(text);
  return clean(person ? text.slice(0, person.index) : text, 300).replace(/^[\s:,]+/, '');
}

/**
 * The page ODM's tracker at odmexpress.com.mx/rastreo-2 renders for one guide:
 * a table of its rows, oldest first, each with the guide, a day, the clock of
 * the branch that scanned it and the observation. Every row must name the guide
 * asked; the not-found notice must too. The clocks carry no zone, and ODM runs
 * branches on several of Mexico's, so each stays a wall clock. The link to the
 * scanned delivery receipt is not read.
 */
export function parseOdm(html: string, raw: string): CarrierResult {
  const guide = normalizeOdmGuide(raw);
  const $ = load(html);
  const block = $('#resultados_rastreo');
  if (block.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ODM Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'ODM Express did not return its tracking page');
  }
  // The page leaves its table open, so a parser moves the paragraphs after it ahead of the
  // table, inside the block: the notice is read from its own cell.
  const missing = NOT_FOUND.exec(clean(block.find('td.texto').first().text(), 200));
  const rows = block.find('tr.rastreorow').toArray();
  if (missing && !rows.length) {
    if (missing[1]!.toUpperCase() !== guide) throw new IndeterminateError(PROVIDER, 'ODM Express answered for another guide');
    throw new NotFoundError(PROVIDER);
  }
  const headings = block.find('th').toArray().map((cell) => clean($(cell).text(), 40)).join('|');
  if (headings !== HEADINGS || !rows.length) throw new SchemaError(PROVIDER, 'ODM Express returned an unrecognized history table');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ODM Express returned an oversized history');

  const events: CarrierEvent[] = rows.map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'ODM Express returned an incomplete row');
    const text = (index: number, length: number) => clean(cells.eq(index).text(), length);
    if (text(0, 64).toUpperCase() !== guide) throw new IndeterminateError(PROVIDER, 'ODM Express answered for another guide');
    const day = DAY.exec(text(1, 40));
    const clock = CLOCK.exec(text(2, 20));
    const date = day && calendarDay(Number(day[1]), Number(day[2]), Number(day[3]));
    if (!date || !clock) throw new SchemaError(PROVIDER, 'ODM Express returned a row without a valid day and clock');
    const description = odmWording(text(3, 500));
    if (!description) throw new SchemaError(PROVIDER, 'ODM Express returned a row without its observation');
    const location = RECEIVED.exec(description)?.[1];
    const staged = odmStage(description);
    return {
      local_time: `${date}T${clock[0]}`,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  // Newest first; rows of one second keep the page's order, the later one first.
  events.reverse();
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
