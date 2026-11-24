import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { decodeText, fetchBounded, textFromHtml, userAgentOf } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const JADLOG_PROVIDER = 'Jadlog';
const ORIGIN = 'https://www.jadlog.com.br';
/** Jadlog's search page: its tracker shows a parcel only after the form's reCAPTCHA. */
export const JADLOG_SEARCH_URL = `${ORIGIN}/jadlog/home`;
/** The address the tracking form posts `cte` to. */
export const JADLOG_SITE_URL = `${ORIGIN}/jadlog/rastreio`;
const MAX_BYTES = 1_000_000;
const MAX_EVENTS = 100;

// The page Jadlog redirects an unknown number to: "Não identificamos o número da sua remessa".
const NOT_FOUND = /^(?:https:\/\/www\.jadlog\.com\.br)?\/jadlog\/erroRastreio\/?$/;
const CHALLENGE = /_cf_chl_opt|\/cdn-cgi\/challenge-platform\/|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;
const QUERY = /Status referente à consulta:\s*([^<]*)</;
const PANEL = /id="heading([^"]*)"/g;
const ROW = /class="txt-status"[^>]*>([\s\S]*?)<br\s*\/?>\s*<small class="txt-data"[^>]*>([^<]*)<\/small>/g;
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})$/;

/** A row's stage: Jadlog's map, else the shared wording rules. */
function stageOf(description: string): { stage: Stage; source: string } | undefined {
  const mapped = statusMap.stage(null, description);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? undefined : { stage: worded.stage, source: worded.source };
}

/**
 * The tracker's page for one number. It repeats the number asked and lists, under one panel per
 * shipment it matched, each row's wording and its wall clock in São Paulo, oldest first. The field
 * also takes a sender's CNPJ, whose shipments come as several panels.
 */
export function parseJadlogPage(html: string, number: string): CarrierResult {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(JADLOG_PROVIDER, 'Jadlog answered with a browser check');
  const query = QUERY.exec(html)?.[1];
  if (query === undefined) throw new SchemaError(JADLOG_PROVIDER, 'Jadlog did not return its tracking result');
  if (textFromHtml(query, 40) !== number) throw new SchemaError(JADLOG_PROVIDER, 'Jadlog answered for a different number');
  const panels = [...html.matchAll(PANEL)].length;
  if (panels > 1) throw new IndeterminateError(JADLOG_PROVIDER, 'Jadlog listed several shipments for the number', { reason: 'several_parcels' });
  const rows = [...html.matchAll(ROW)];
  if (!panels || !rows.length) throw new NoHistoryError(JADLOG_PROVIDER, 'Jadlog has no scans for the shipment yet', { reason: 'listed' });
  if (rows.length > MAX_EVENTS) throw new SchemaError(JADLOG_PROVIDER, 'Jadlog returned too many scans');
  const events: CarrierEvent[] = rows.map(([, wording, clock]) => {
    const description = textFromHtml(wording, 300);
    const parts = CLOCK.exec(textFromHtml(clock, 40));
    if (!description || !parts) throw new SchemaError(JADLOG_PROVIDER, 'Jadlog returned a scan without its wording or clock');
    const [, day, month, year, hour, minute] = parts;
    const staged = stageOf(description);
    return { local_time: `${year}-${month}-${day}T${hour}:${minute}`, description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  }).reverse();
  // Older histories show the delivery's wording before another round to the address: the parcel was
  // still on its way.
  const moved = events.findIndex((event) => event.stage && event.stage !== 'delivered');
  for (const event of events.slice(moved + 1)) {
    if (moved >= 0 && event.stage === 'delivered') Object.assign(event, { stage: 'in_transit', stage_source: 'carrier_map' });
  }
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    tracking_url: JADLOG_SEARCH_URL,
    events,
  };
}

/**
 * Jadlog's own tracker: the form's POST of `cte`. The page asks for a reCAPTCHA answer before it
 * submits the form, but the server reads the number without one. An unknown number is redirected
 * to the error page.
 */
export async function readJadlogSite(number: string, options: { fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal;
  timeoutMs: number }): Promise<CarrierResult> {
  const { response, bytes } = await fetchBounded(JADLOG_SITE_URL, {
    method: 'POST', body: new URLSearchParams({ cte: number }).toString(), signal: options.signal,
    headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(options.userAgent),
      Origin: ORIGIN, Referer: `${ORIGIN}/jadlog/captcha` },
  }, { provider: JADLOG_PROVIDER, timeoutMs: options.timeoutMs, maxBytes: MAX_BYTES, redirect: 'manual', fetcher: options.fetcher,
    allowHttpStatuses: [301, 302, 303, 307, 308, 403, 503] });
  options.signal.throwIfAborted();
  const { status } = response;
  if (status >= 300 && status < 400) {
    if (NOT_FOUND.test(response.headers.get('location') ?? '')) throw new NotFoundError(JADLOG_PROVIDER);
    // The tracker sends a request without a number back to its home page.
    throw new IndeterminateError(JADLOG_PROVIDER, `Jadlog redirected the lookup (HTTP ${status})`);
  }
  const html = decodeText(bytes);
  if (status !== 200) {
    if (CHALLENGE.test(html.slice(0, 64_000)) || response.headers.get('cf-mitigated') === 'challenge') {
      throw new ChallengeError(JADLOG_PROVIDER, 'Jadlog answered with a browser check');
    }
    throw new UpstreamHttpError(JADLOG_PROVIDER, status);
  }
  return parseJadlogPage(html, number);
}
