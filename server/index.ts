import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { carrierDefinition } from '../core/catalog/index.js';
import { detectCarrierMatch, normalizeTrackingNumber, validTrackingNumber } from '../core/detection/index.js';
import { InputRequiredError } from '../core/errors/index.js';
import { createTracker, TrackingError, type ParcelInput, type Tracker, type TrackerOptions, type TrackingResponse } from '../facade/index.js';
import { CARRIER_CATALOG } from '../generated/catalog.js';
import { demoPage } from './page.js';

export interface TrackingServerOptions extends TrackerOptions {
  token?: string;
  demoPage?: boolean;
  tracker?: Tracker;
  rateLimit?: number;
  cacheMs?: number;
  maxConcurrent?: number;
  /** Receives route names and status only; input and error objects never enter logs. */
  log?: (record: { method: string; route: string; status: number; durationMs: number }) => void;
  now?: () => number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(`Invalid ${name}`);
  return value;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Use application/json');
  const limit = 16_384;
  if (Number(request.headers['content-length']) > limit) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(Buffer.from(chunk));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Supply a JSON object');
  return parsed as Record<string, unknown>;
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Shared, bounded memory only: no accounts, parcel store, scheduler or database. */
export function createTrackingServer(options: TrackingServerOptions = {}) {
  const tracker = options.tracker ?? createTracker({ ...options, providerSpacingMs: options.providerSpacingMs ?? 1_000 });
  const now = options.now ?? Date.now;
  const rateLimit = positive(options.rateLimit ?? 30, 'rate limit');
  const maxConcurrent = positive(options.maxConcurrent ?? 8, 'concurrency');
  const cacheMs = positive(options.cacheMs ?? 600_000, 'cache interval');
  const clients = new Map<string, { until: number; count: number }>();
  const cache = new Map<string, { until: number; value: TrackingResponse }>();
  const pending = new Map<string, Promise<TrackingResponse>>();
  const routes = new Set(['/v1/carriers', '/v1/detect', '/v1/recognize', '/v1/track', '/health', '/openapi.json', '/', '/assets/scraper.js']);
  let active = 0;

  function limited(request: IncomingMessage): boolean {
    // Proxy headers are untrusted; configure rate limiting at the proxy too when sharing it.
    const client = request.socket.remoteAddress ?? 'unknown';
    const time = now();
    if (clients.size >= 10_000 && !clients.has(client)) {
      for (const [key, value] of clients) if (value.until <= time) clients.delete(key);
      if (clients.size >= 10_000) return true;
    }
    let window = clients.get(client);
    if (!window || window.until <= time) { window = { until: time + 60_000, count: 0 }; clients.set(client, window); }
    return ++window.count > rateLimit;
  }

  async function tracked(input: ParcelInput, budgetMs?: number): Promise<TrackingResponse> {
    if (typeof input.number !== 'string' || input.number.length > 80 || !validTrackingNumber(input.number)) throw new TypeError('Invalid tracking number');
    if (input.carrier !== undefined && (typeof input.carrier !== 'string' || !input.carrier)) throw new TypeError('Invalid carrier');
    const number = normalizeTrackingNumber(input.number);
    const detected = detectCarrierMatch(number);
    input = { ...input, number, carrier: input.carrier ?? (detected.confidence === 'high' ? detected.carrier : undefined) };
    const key = createHash('sha256').update(JSON.stringify([input.number, input.carrier, input.postcode, input.trackingUrl])).digest('hex');
    const previous = cache.get(key);
    if (previous && previous.until > now()) return previous.value;
    if (previous) cache.delete(key);
    const inFlight = pending.get(key);
    if (inFlight) return await inFlight;
    if (active >= maxConcurrent) throw new HttpError(429, 'Tracking is busy; retry later');
    const operation = (async () => {
      active++;
      try {
        const value = await tracker.track(input, { budgetMs });
        const refresh = (carrierDefinition(value.carrier).tracking as { refresh?: { minMinutes: number } }).refresh;
        const ttl = Math.max(cacheMs, (refresh?.minMinutes ?? 0) * 60_000);
        if (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
        cache.set(key, { until: now() + ttl, value });
        return value;
      } finally { active--; }
    })();
    pending.set(key, operation);
    try { return await operation; }
    finally { pending.delete(key); }
  }

  const server = createServer(async (request, response) => {
    const started = performance.now();
    let route = 'unknown';
    response.on('finish', () => {
      try { options.log?.({ method: request.method ?? 'unknown', route, status: response.statusCode, durationMs: Math.round(performance.now() - started) }); }
      catch { /* Logging cannot change an answer. */ }
    });
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      route = routes.has(path) ? path : 'unknown';
      if (request.method === 'GET' && path === '/health') { json(response, 200, { ok: true }); return; }
      if (request.method === 'GET' && options.demoPage && path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        response.end(demoPage); return;
      }
      if (request.method === 'GET' && options.demoPage && path === '/assets/scraper.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(new URL('../browser/scraper.js', import.meta.url))); return;
      }
      if (!authorized(request, options.token)) { json(response, 401, { error: 'Authentication required' }); return; }
      if (limited(request)) { response.setHeader('Retry-After', '60'); json(response, 429, { error: 'Rate limit exceeded' }); return; }
      if (request.method === 'GET' && path === '/v1/carriers') { json(response, 200, CARRIER_CATALOG); return; }
      if (request.method === 'GET' && path === '/openapi.json') {
        json(response, 200, JSON.parse(await readFile(new URL('./openapi.json', import.meta.url), 'utf8'))); return;
      }
      if (!['/v1/detect','/v1/recognize','/v1/track'].includes(path)) { json(response, 404, { error: 'Not found' }); return; }
      if (request.method !== 'POST') { json(response, 405, { error: 'Use POST' }); return; }
      const input = await body(request);
      const allowed = path === '/v1/detect' ? ['text'] : path === '/v1/recognize' ? ['number','budgetMs']
        : ['number','carrier','postcode','trackingUrl','budgetMs'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown request field');
      if (path === '/v1/detect') { json(response, 200, tracker.detect(input.text as string)); return; }
      if (input.budgetMs !== undefined && (typeof input.budgetMs !== 'number' || !Number.isInteger(input.budgetMs) || input.budgetMs < 1 || input.budgetMs > 120_000)) throw new HttpError(400, 'Invalid lookup budget');
      if (path === '/v1/recognize') { json(response, 200, await tracker.recognize(input.number as string, { budgetMs: input.budgetMs as number | undefined })); return; }
      const result = await tracked({ number: input.number as string, carrier: input.carrier as string | undefined,
        postcode: input.postcode as string | null | undefined, trackingUrl: input.trackingUrl as string | null | undefined }, input.budgetMs as number | undefined);
      json(response, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) response.setHeader('Retry-After', '60');
        json(response, error.status, { error: error.message });
      } else if (error instanceof TrackingError) {
        const status = error.hint.kind === 'not_found' ? 404 : error.hint.kind === 'rate_limited' ? 429 : 502;
        if (error.hint.retryAfterMs !== undefined) response.setHeader('Retry-After', String(Math.ceil(error.hint.retryAfterMs / 1_000)));
        json(response, status, { error: error.message, attempts: error.attempts, hint: error.hint });
      } else if (error instanceof InputRequiredError) {
        json(response, 400, { error: 'Additional carrier input required', field: error.field });
      } else if (error instanceof TypeError || error instanceof RangeError) {
        json(response, 400, { error: 'Invalid tracking input' });
      } else {
        json(response, 502, { error: 'Tracking is temporarily unavailable' });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
