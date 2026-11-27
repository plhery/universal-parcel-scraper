// HuaHan's guest form opens a verification session (`init.php`), shows a picture whose
// characters are clicked in order (`tncode.php`), checks the clicks (`check.php`) and then
// answers one waybill (`CargoTrackActionPlus.php`) in the same cookie session. The adapter's
// own HTTP client cannot read the picture; this helper runs the same requests here and reads
// it with the OCR worker ZTO's helper uses. Unproxied it opens no browser context; through a
// request's proxy its requests leave through a fresh context's request client.
import { solveZtoCharacters } from './zto-ocr.mjs';

const BASE = 'https://www.hh-exp.cn/WebTrack/';
const PAGE = `${BASE}CargoTrack.html`;
export const HUAHAN_TRACKING = `${BASE}CargoTrackActionPlus.php`;
const NUMBER = /^HHW[A-Z]{2}\d{10}YQ$/;
const TOKEN = /^[a-zA-Z0-9_-]{8,256}$/;
const PICTURE = /^data:image\/(?:webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// The widget's refusals that a new picture would not lift.
const REFUSED = /频繁|上限|繁忙|冷却|too many|rate limit/i;
const MAX_BODY = 1_000_000;
// Each picture opens a verification session, and HuaHan caps those per address and hour. The worker
// is unsure of about two pictures in five, so two unsure pictures in a row ended about one lookup in six.
const MAX_PICTURES = 3;
// A later picture opens only with this much time left: one read, checked and answered took about 11 s.
const PICTURE_MS = 12_000;
// The worker's own score: pictures it read at 0.99 and better passed, one it read at 0.12 did not.
const MIN_CONFIDENCE = 0.5;
// The picture is 240 by 150 pixels; the clicks are offsets in it.
const REGION = { x: 0, y: 0, width: 240, height: 150 };
const reportVerification = fields => console.warn(JSON.stringify({ level: 'warn', event: 'huahan.verification', host: 'www.hh-exp.cn', ...fields }));

/** The one complete waybill the adapter asks for, bound to the tracking reply alone. */
export function huahanVerifyNumber(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = url.searchParams.get('ordernumber') ?? '';
  return url.origin + url.pathname === PAGE && !url.username && !url.password && !url.hash
    && [...url.searchParams].length === 1 && NUMBER.test(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === HUAHAN_TRACKING ? number : null;
}

/** The widget's two-operand arithmetic question, when HuaHan serves it instead of the picture. */
export function huahanAnswer(question) {
  const match = typeof question === 'string' && /^\s*(\d{1,3})\s*([+\-×*x÷/])\s*(\d{1,3})\s*=\s*\?\s*$/.exec(question);
  if (!match) return null;
  const a = Number(match[1]), b = Number(match[3]);
  const answer = match[2] === '+' ? a + b : match[2] === '-' ? a - b : /[×*x]/.test(match[2]) ? a * b : a / b;
  return Number.isSafeInteger(answer) ? String(answer) : null;
}

/** The characters to click, in order, and the picture's bytes, or null. */
export function huahanPicture(challenge) {
  if (!challenge || challenge.ask !== 1 || challenge.type === 'text' || typeof challenge.img !== 'string' || !Array.isArray(challenge.tip)) return null;
  const tip = challenge.tip;
  const image = challenge.img.length <= 1_400_000 ? PICTURE.exec(challenge.img)?.[1] : undefined;
  if (tip.length < 2 || tip.length > 4 || tip.some(character => typeof character !== 'string' || !/^[㐀-鿿]$/.test(character))
    || (challenge.count != null && challenge.count !== tip.length) || !image) return null;
  return { targets: tip.join(''), image };
}

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const kept = (source, names, limit) => Object.fromEntries(names.map(name => [name, text(source?.[name], limit)])
  .filter(([, value]) => value !== undefined));

/** The reply's tracking fields; the shipper's reference, names and addresses stay out. */
export function projectHuahanReply(body) {
  let reply;
  try { reply = JSON.parse(body); } catch { return null; }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const projected = { ...(Number.isInteger(reply.ask) ? { ask: reply.ask } : {}), ...kept(reply, ['msg'], 200) };
  if (Array.isArray(reply.data)) {
    // Over-long fields and histories stay over the parser's limits, which reject them.
    projected.data = reply.data.slice(0, 5).map(row => row && typeof row === 'object' && !Array.isArray(row) ? {
      ...kept(row, ['Code', 'Error_code', 'Status', 'Country_code', 'Local_Carrier', 'Local_Number'], 1000),
      ...(Array.isArray(row.Detail) ? { Detail: row.Detail.slice(0, 501).map(scan => scan && typeof scan === 'object'
        ? kept(scan, ['Comment', 'Occur_date', 'Status', 'track_area'], 1000) : null) } : {}),
    } : null);
  }
  return JSON.stringify(projected);
}

const parse = body => { try { return JSON.parse(body ?? ''); } catch { return null; } };

const aborted = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/**
 * A fetch through a browser context's request client, which leaves through the context's proxy.
 * The helper keeps each session's cookies itself, so the context's are cleared before each
 * request; redirects are not followed.
 */
export function contextFetcher(context) {
  return async (url, { method = 'GET', headers = {}, body, signal } = {}) => {
    signal?.throwIfAborted();
    await context.clearCookies();
    const sent = context.request.fetch(url, { method, headers, ...(body === undefined ? {} : { data: body }),
      maxRedirects: 0, failOnStatusCode: false });
    sent.catch(() => {});
    const response = await (signal ? Promise.race([sent, aborted(signal)]) : sent);
    const named = name => response.headersArray().filter(header => header.name.toLowerCase() === name).map(header => header.value);
    return {
      status: response.status(),
      headers: { get: name => named(name.toLowerCase()).at(0) ?? null, getSetCookie: () => named('set-cookie') },
      text: () => response.text(),
      body: { cancel: () => response.dispose() },
    };
  };
}

/**
 * Up to three pictures, each in its own verification session, a later one only while the time
 * left covers it; a picture the worker reads with little confidence is not submitted. The result carries the tracking reply, or a refusal as the
 * widget gave it, under the tracking address; none when no picture passed.
 */
export async function runHuahanVerify({ url, capture, tier, maxTimeout, signal, fetcher = globalThis.fetch,
  openContext, handle, cleanupMs = 1500, solve = solveZtoCharacters, onReport = reportVerification }) {
  const number = huahanVerifyNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now(), entries = [], cookies = new Map();
  const tally = { pictures: 0, unsure: 0, checks: 0, refused: 0, outcome: 'unpassed',
    abstentions: { missingPoints: 0, pointCount: 0, confidence: 0, coordinates: 0 } };
  const ending = new AbortController();
  const combined = signal ? AbortSignal.any([signal, ending.signal]) : ending.signal;
  let timer, context;
  const left = () => maxTimeout - (Date.now() - start);
  const entry = fields => {
    entries.push({ url: HUAHAN_TRACKING, status: 200, headers: {}, body: null, truncated: false, base64Encoded: false,
      error: null, trackingNumberSubmitted: number, ...fields });
  };
  const keep = response => {
    const lines = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of lines.slice(0, 10)) {
      const pair = line.split(';')[0], at = pair.indexOf('=');
      if (at > 0 && at < 64 && pair.length < 512) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  };
  const request = async (path, maxBytes, body) => {
    const timeoutMs = Math.floor(Math.min(15000, left()));
    if (timeoutMs < 1 || combined.aborted) throw new Error('HuaHan verification budget exhausted');
    const response = await fetcher(BASE + path, { method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.any([combined, AbortSignal.timeout(timeoutMs)]),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': USER_AGENT, Referer: PAGE, 'X-Requested-With': 'XMLHttpRequest',
        ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(body ? { body } : {}) });
    keep(response);
    const length = Number(response.headers.get('content-length') ?? 0);
    const contentType = response.headers.get('content-type')?.slice(0, 100);
    if (!Number.isSafeInteger(length) || length > maxBytes) { await response.body?.cancel(); return { status: response.status, body: null, contentType }; }
    const read = await response.text();
    return { status: response.status, body: read.length > maxBytes ? null : read, contentType };
  };
  // A refusal or page in place of the widget's JSON ends the lookup with it.
  const refused = (reply, payload) => {
    if (reply.status !== 200 || reply.body === null || /^\s*</.test(reply.body)) {
      entry({ status: reply.status, error: 'HuaHan verification returned a page' });
      return true;
    }
    if (payload?.ask === 0) {
      tally.refused++;
      entry({ body: JSON.stringify({ ask: 0, ...kept(payload, ['msg'], 200) }) });
      return true;
    }
    return false;
  };
  // A context that opens after the deadline closes on arrival.
  const close = async target => {
    let closed = false, cleanup;
    await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }, () => {}),
      new Promise(resolve => { cleanup = setTimeout(resolve, cleanupMs); })]);
    clearTimeout(cleanup);
    if (!closed) handle?.requestBrowserReplacement?.('HuaHan context cleanup failed');
  };
  const lookup = async () => {
    if (openContext) {
      const opened = await openContext();
      if (combined.aborted) { await close(opened); return; }
      context = opened;
      fetcher = contextFetcher(context);
    }
    for (let picture = 0; picture < MAX_PICTURES && !combined.aborted; picture++) {
      if (picture > 0 && left() < PICTURE_MS) return;
      cookies.clear();
      const init = await request(`init.php?_=${Date.now()}`, 4096);
      const opened = parse(init.body);
      if (refused(init, opened)) return;
      if (opened?.ask !== 1 || typeof opened.token !== 'string' || !TOKEN.test(opened.token)) {
        entry({ error: 'HuaHan did not open verification' });
        return;
      }
      const shown = await request(`tncode.php?${new URLSearchParams({ token: opened.token, _: String(Date.now()) })}`, 1_500_000);
      const challenge = parse(shown.body);
      if (refused(shown, challenge)) return;
      let proof;
      if (challenge?.ask === 1 && challenge.type === 'text') {
        const answer = huahanAnswer(challenge.question);
        if (!answer) { entry({ error: 'HuaHan presented an unsupported verification question' }); return; }
        proof = { answer };
      } else {
        const read = huahanPicture(challenge);
        if (!read) { entry({ error: 'HuaHan presented an unsupported verification mode' }); return; }
        tally.pictures++;
        const solved = await solve({ ...read, region: REGION }, combined, Math.floor(Math.min(20000, left() - 3000)));
        const points = Array.isArray(solved?.points) ? solved.points : [];
        if (points.length !== read.targets.length || !(solved.confidence >= MIN_CONFIDENCE)
          || points.some(point => !(point?.x >= 0 && point.x < REGION.width && point?.y >= 0 && point.y < REGION.height))) {
          tally.unsure++;
          const reason = !Array.isArray(solved?.points) ? 'missingPoints'
            : points.length !== read.targets.length ? 'pointCount'
              : !(solved.confidence >= MIN_CONFIDENCE) ? 'confidence' : 'coordinates';
          tally.abstentions[reason]++;
          continue;
        }
        proof = { clicks: points.map(point => `${Math.round(point.x)},${Math.round(point.y)}`).join(';') };
      }
      tally.checks++;
      const checked = await request(`check.php?${new URLSearchParams({ token: opened.token, ...proof })}`, 4096);
      if (checked.status !== 200 || checked.body?.trim() !== 'ok') {
        const message = parse(checked.body)?.msg;
        if (typeof message === 'string' && REFUSED.test(message)) {
          tally.refused++;
          entry({ body: JSON.stringify({ ask: 0, msg: message.slice(0, 200) }) });
          return;
        }
        continue;
      }
      const reply = await request('CargoTrackActionPlus.php', MAX_BODY, new URLSearchParams({ ordernumber: number }).toString());
      const page = reply.body !== null && /^\s*</.test(reply.body);
      const body = reply.body === null || page ? null : projectHuahanReply(reply.body);
      tally.outcome = 'passed';
      entry({ status: reply.status, headers: reply.contentType ? { 'content-type': reply.contentType } : {}, body,
        truncated: reply.body === null, error: page ? 'HuaHan verification returned a page'
          : reply.body !== null && body === null ? 'HuaHan tracking reply is not JSON' : null });
      return;
    }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || combined.aborted) throw new Error('No HuaHan budget');
    await Promise.race([lookup(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('HuaHan verification budget exhausted')), maxTimeout);
    })]);
  } catch {
    tally.outcome = entries.length ? tally.outcome : 'failed';
  } finally {
    clearTimeout(timer);
    ending.abort();
    if (context) await close(context);
    onReport({ ...tally, abstentions: { ...tally.abstentions }, durationMs: Date.now() - start });
  }
  // TRAWL forwards captures from a successful tier; an empty list is the unpassed picture.
  return { tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url, html: '', body: new Uint8Array(),
    statusCode: 200, cookies: [], capturedResponses: entries.slice(-1) };
}
