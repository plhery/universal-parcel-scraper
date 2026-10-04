import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import type { Page, Response as BrowserResponse } from 'playwright-core';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeUkrposhtaNumber, parseUkrposhtaHistory, parseUkrposhtaOverview } from './parser.js';

export const UKRPOSHTA_API = 'https://track.ukrposhta.ua/php/track_new.php';
const MAX_BYTES = 1_000_000;

export function ukrposhtaTrackingUrl(number: string): string {
  const url = new URL('https://track.ukrposhta.ua/en/');
  url.searchParams.set('barcode', number);
  return url.toString();
}

function httpFailure(status: number, retryAfterMs?: number): Error {
  const cause = new UpstreamHttpError('ukrposhta', status, retryAfterMs);
  return [404, 410].includes(status)
    ? new TransportError('ukrposhta', 'Ukrposhta tracking endpoint is unavailable', { cause, status }) : cause;
}

function requestMatches(response: BrowserResponse, page: Page, number: string): boolean {
  const request = response.request();
  let body: unknown;
  try { body = request.postDataJSON(); } catch { return false; }
  return response.url() === UKRPOSHTA_API && request.method() === 'POST'
    && request.frame() === page.mainFrame() && isRecord(body) && body.barcode === number && body.lang === 'EN';
}

async function readLookup(page: Page, number: string, deadline: number, signal: AbortSignal, budgetMs: number): Promise<unknown> {
  signal.throwIfAborted();
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) throw new BudgetExceededError('ukrposhta', budgetMs);
  const captured = page.waitForResponse(response => response.url() === UKRPOSHTA_API && response.request().method() === 'POST', { timeout: remainingMs });
  void captured.catch(() => {});
  const navigation = await page.goto(ukrposhtaTrackingUrl(number), { waitUntil: 'domcontentloaded', timeout: remainingMs });
  signal.throwIfAborted();
  if (!navigation) throw new TransportError('ukrposhta', 'Ukrposhta tracking page is unavailable');
  if ([401, 403].includes(navigation.status())) throw new ChallengeError('ukrposhta');
  if (navigation.status() !== 200) throw httpFailure(navigation.status());
  const response = await captured;
  signal.throwIfAborted();
  if (!requestMatches(response, page, number)) throw new SchemaError('ukrposhta', 'The browser submitted a different tracking request');
  if ([401, 403].includes(response.status())) throw new ChallengeError('ukrposhta');
  if (response.status() !== 200) {
    const retryAfter = response.headers()['retry-after'];
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : undefined;
    throw httpFailure(response.status(), retryAfterMs);
  }
  if (Number(response.headers()['content-length']) > MAX_BYTES) throw new SchemaError('ukrposhta', 'Ukrposhta returned excessive tracking data');
  const bytes = await response.body();
  signal.throwIfAborted();
  if (bytes.length > MAX_BYTES) throw new SchemaError('ukrposhta', 'Ukrposhta returned excessive tracking data');
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch (cause) { throw new SchemaError('ukrposhta', 'Ukrposhta returned invalid tracking JSON', { cause }); }
}

function localBrowser(number: string, executablePath: string, signal: AbortSignal, timeoutMs: number) {
  return withLocalBrowser({ provider: 'ukrposhta', executablePath, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    // Waiting for the browser and launching it already spent part of the budget.
    const deadline = performance.now() + remainingMs();
    const context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block' });
    session.throwIfAborted();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const allowed = url.protocol === 'https:' && ['track.ukrposhta.ua', 'www.google.com', 'www.gstatic.com', 'www.recaptcha.net'].includes(url.hostname);
      await (allowed ? route.continue() : route.abort());
    });
    session.throwIfAborted();
    const page = await context.newPage();
    session.throwIfAborted();
    // The native repeated-reference batch supplies a barcode-bound latest
    // scan and total count. Its single-reference mode supplies full history.
    const overview = parseUkrposhtaOverview(await readLookup(page, `${number},${number}`, deadline, session, timeoutMs), number);
    return parseUkrposhtaHistory(await readLookup(page, number, deadline, session, timeoutMs), overview);
  });
}

export class UkrposhtaTracker {
  constructor(private readonly options: { executablePath?: string | null; recorder?: StepRecorder } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeUkrposhtaNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Ukrposhta budget must be between 1 and 60000 ms');
    if (!this.options.executablePath) throw new ChallengeError('ukrposhta', 'Ukrposhta requires a configured tracking browser');
    return runSteps({ carrier: 'ukrposhta', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'browser', run: ({ signal, remainingMs }) => localBrowser(number, this.options.executablePath!, signal, Math.max(1, Math.floor(remainingMs))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new UkrposhtaTracker({ executablePath: environment.browserExecutablePath, recorder: environment.recorder });
  return { id: 'ukrposhta', recordsSteps: true, steps: ['browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
