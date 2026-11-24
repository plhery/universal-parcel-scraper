/**
 * Interparcel's tracking page, shared by its sites: Interparcel UK and Interparcel Australia.
 * Each site's folder declares an `InterparcelSite`; the page, its reading and the status
 * letters' map (`./status.ts`) are the same on every site, and each site answers only for
 * the references it issued.
 */
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import { interparcelStage } from './status.js';

/** One Interparcel site, which tracks the references it issued. */
export interface InterparcelSite {
  readonly carrier: string;
  readonly provider: string;
  readonly origin: string;
  /** The two letters that open the site's references. */
  readonly prefix: string;
}

// A page with a long history is under a hundred kilobytes.
export const INTERPARCEL_MAX_BYTES = 1_000_000;
// Bot checks Cloudflare puts in place of the page.
export const INTERPARCEL_CHALLENGE = /_cf_chl_opt|cf-turnstile|cf-error-details|<title>\s*Just a moment|<title>\s*Attention Required/i;
const REDIRECTS = [301, 302, 303, 307, 308];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// "13th November, 2025 11:47am": a summary row's date and clock.
const SUMMARY_CLOCK = /^(\d{1,2})(?:st|nd|rd|th) ([A-Za-z]{3,9}),? (\d{4}) (\d{1,2}):([0-5]\d) ?(am|pm)$/i;
// "Thu 13th Nov" and "11:47": a detailed row's day without its year, and its clock.
const ROW_DAY = /^([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th) ([A-Za-z]{3})$/;
const ROW_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CODE = /^status([A-Z])$/;
const ONLINE = /^online$/i;
const MAX_ROWS = 300;

/** A reference the site issued: its two letters, then ten digits. */
export function normalizeInterparcelNumber(site: InterparcelSite, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!new RegExp(`^${site.prefix}\\d{10}$`).test(number)) {
    throw new InvalidInputError(site.provider, `${site.provider} tracking numbers are ${site.prefix} and ten digits`);
  }
  return number;
}

/** The tracking page of one reference on the site. */
export function interparcelTrackingUrl(site: InterparcelSite, raw: string): string {
  return `${site.origin}/tracking/${normalizeInterparcelNumber(site, raw)}`;
}

const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const twoDigits = (value: number) => String(value).padStart(2, '0');

type Row = CarrierEvent & { local_time: string; description: string };
type Summary = { code: string; description: string; local_time: string; location: string; year: number };

function reader(site: InterparcelSite) {
  const invalid = (message: string): never => { throw new SchemaError(site.provider, message); };

  /** The summary's rows: Interparcel's wording for some of the scans, with its status letters and their years. */
  function summaryRows($: CheerioAPI): Summary[] {
    return $('#abbreviatedEvents > div').toArray().flatMap((row): Summary[] => {
      const roundel = $(row).find('.trackRoundel');
      // The list opens and closes with an empty row.
      if (!roundel.length) return [];
      const code = roundel.attr('class')?.split(/\s+/).map(name => CODE.exec(name)?.[1]).find(Boolean) ?? invalid(`${site.provider} returned a summary row without its status`);
      const text = $(row).children().last().children('div').toArray().map(cell => clean($(cell).text(), 300));
      const clock = SUMMARY_CLOCK.exec(clean($(row).find('.rightDate').text(), 60));
      const [description = '', , location = ''] = text;
      if (!clock || !description) return invalid(`${site.provider} returned an invalid summary row`);
      const year = Number(clock[3]);
      const date = calendarDay(year, monthOf(clock[2]!), Number(clock[1]));
      const hour = Number(clock[4]) % 12 + (clock[6]!.toLowerCase() === 'pm' ? 12 : 0);
      if (!date || monthOf(clock[2]!) === 0 || Number(clock[4]) > 12 || Number(clock[4]) === 0) return invalid(`${site.provider} returned an invalid summary clock`);
      return [{ code, description, local_time: `${date}T${twoDigits(hour)}:${clock[5]}:00`, location, year }];
    });
  }

  /**
   * The day of a detailed row, whose year the page leaves out: of the years around the summary's
   * newest, the one whose calendar puts the row's weekday on its day. Three years in a row never
   * share a weekday for a day.
   */
  function rowDate(day: string, newestYear: number): string {
    const parts = ROW_DAY.exec(day);
    const weekday = parts ? WEEKDAYS.indexOf(parts[1]!.toLowerCase()) + 1 : 0;
    const month = parts ? monthOf(parts[3]!) : 0;
    if (!parts || weekday === 0 || month === 0) return invalid(`${site.provider} returned an invalid row date`);
    const dates = [newestYear + 1, newestYear, newestYear - 1].flatMap(year => {
      const date = calendarDay(year, month, Number(parts[2]));
      return date && DateTime.fromISO(date, { zone: 'utc' }).weekday === weekday ? [date] : [];
    });
    return dates.length === 1 ? dates[0]! : invalid(`${site.provider} returned a row date outside the summary's years`);
  }

  /** The detailed rows, newest first: Interparcel's own steps and the courier's scans, in the courier's words. */
  function detailedRows($: CheerioAPI, newestYear: number): Row[] {
    const seen = new Set<string>();
    return $('#allEvents tr').toArray().flatMap((row): Row[] => {
      const cells = $(row).children('td').toArray().map(cell => clean($(cell).text(), 300));
      // The table's first row names its columns.
      if (cells[0] === 'Date') return [];
      if (cells.length !== 4) return invalid(`${site.provider} returned an invalid row`);
      const [day, time, description, location] = cells as [string, string, string, string];
      const clock = ROW_CLOCK.exec(time);
      if (!clock || !description) return invalid(`${site.provider} returned an invalid row`);
      const event: Row = { local_time: `${rowDate(day, newestYear)}T${clock[1]}:${clock[2]}:00`, description, ...(location ? { location } : {}) };
      // A courier can repeat a scan word for word.
      const key = JSON.stringify([event.local_time, description, location]);
      return seen.has(key) ? [] : (seen.add(key), [event]);
    });
  }

  /**
   * Each summary row's status letter, on the detailed row it restates: the one at its clock
   * and place in the same words, or else the first one there the summary has not used.
   */
  function withCodes(rows: Row[], summary: readonly Summary[]): Array<Row & { provider_code?: string }> {
    const codes = new Map<number, string>();
    const place = (row: { local_time: string; location?: string }) => `${row.local_time} ${row.location ?? ''}`;
    const unmatched: Summary[] = [];
    for (const entry of summary) {
      const index = rows.findIndex((row, at) => !codes.has(at) && place(row) === place(entry) && row.description === entry.description);
      if (index < 0) unmatched.push(entry);
      else codes.set(index, entry.code);
    }
    for (const entry of unmatched) {
      const index = rows.findIndex((row, at) => !codes.has(at) && place(row) === place(entry));
      if (index >= 0) codes.set(index, entry.code);
    }
    return rows.map((row, index) => (codes.has(index) ? { ...row, provider_code: codes.get(index)! } : row));
  }

  /** Reads the tracking page for one reference. Its clocks keep their wall time: the page gives no zone. */
  return function parse(html: string, number: string): CarrierResult {
    if (INTERPARCEL_CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`);
    const $ = load(html);
    if (!$('#trackingPane').length) {
      // A reference the site does not hold gets the empty track form, with the reference in its box.
      const asked = $('input#trackNumber').attr('value');
      if (asked === undefined) return invalid(`${site.provider} returned an unknown page`);
      if (clean(asked, 40).toUpperCase().replace(/\s/g, '') !== number) throw new IndeterminateError(site.provider, `${site.provider} answered for another reference`);
      throw new NotFoundError(site.provider, `${site.provider} has no parcel for this reference`);
    }
    const label = $('#carrierInfoText > div').toArray().map(cell => clean($(cell).text(), 200));
    const tracked = /^Tracking Number:\s*([A-Z0-9]{1,40})$/.exec(label.find(text => text.startsWith('Tracking Number:')) ?? '')?.[1];
    if (!tracked) return invalid(`${site.provider} returned a page without its tracking number`);
    if (tracked !== number) throw new IndeterminateError(site.provider, `${site.provider} answered for another reference`);
    const details = new Map($('#trackingDetails > div').toArray().map(item => {
      const [name, value] = $(item).children('div').toArray().map(cell => clean($(cell).text(), 200));
      return [name?.replace(/:$/, '') ?? '', value ?? ''] as const;
    }));

    const summary = summaryRows($);
    if (summary.length > MAX_ROWS) return invalid(`${site.provider} returned too many rows`);
    const detailed = summary.length ? detailedRows($, Math.max(...summary.map(entry => entry.year))) : [];
    if (detailed.length > MAX_ROWS) return invalid(`${site.provider} returned too many rows`);
    const rows = detailed.length
      ? withCodes(detailed, summary)
      : summary.map(({ code, description, local_time, location }) => ({ local_time, description, ...(location ? { location } : {}), provider_code: code }));
    if (!rows.length) throw new NoHistoryError(site.provider, `${site.provider} lists the parcel without its steps`, { reason: 'listed' });
    const events: CarrierEvent[] = rows.map(({ location, ...row }) => {
      const staged = interparcelStage(row.provider_code ?? null, row.description);
      // Interparcel's own steps take place "Online".
      return { ...row, ...(location && !ONLINE.test(location) ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    });

    const current = events.find(event => event.stage);
    const service = label.find(text => text && !text.startsWith('Tracking Number:'));
    const destination = countryCode(details.get('Delivery Address')?.split(',').at(-1));
    const signer = details.get('Signed For By');
    return {
      status: current ? languageStageStatus(current.stage as Stage) : 'unknown',
      ...(current ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
      last_status_text: events[0]!.description ?? null,
      last_update: null,
      last_update_local: events[0]!.local_time!,
      expected_delivery: null,
      ...(service ? { service_name: service } : {}),
      ...(destination ? { destination_country: destination } : {}),
      ...(signer ? { signed_by: signer } : {}),
      events,
    };
  };
}

/** Reads one site's tracking page for one reference. */
export function parseInterparcel(site: InterparcelSite, html: string, number: string): CarrierResult {
  return reader(site)(html, number);
}

export class InterparcelTracker {
  private readonly parse: (html: string, number: string) => CarrierResult;

  constructor(private readonly site: InterparcelSite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {
    this.parse = reader(site);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { site } = this;
    const number = normalizeInterparcelNumber(site, raw);
    const url = interparcelTrackingUrl(site, number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: site.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: INTERPARCEL_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 429] });
      const html = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(site.provider);
      if (response.status === 403 || INTERPARCEL_CHALLENGE.test(html.slice(0, 64_000))) {
        throw new ChallengeError(site.provider, `${site.provider} answered with a browser check`, { status: response.status });
      }
      if (response.status !== 200) throw new TransportError(site.provider, `${site.provider}'s tracking page is unavailable`, { status: response.status });
      return this.parse(html, number);
    };
    // Cloudflare checks the page's visitors, so a check the direct read meets goes to the browser
    // service. A read that fails to reach the site gets one more first.
    return runSteps({ carrier: site.carrier, budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: site.provider, url, maxBytes: INTERPARCEL_MAX_BYTES, parse: html => this.parse(html, number) }),
    ]);
  }
}

/** The adapter of one Interparcel site. */
export function interparcelAdapter(site: InterparcelSite): AdapterFactory {
  return (environment) => {
    const tracker = new InterparcelTracker(site, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
    return {
      id: site.carrier, recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
      track: (input, context) => tracker.fetch(input.number, context),
    };
  };
}
