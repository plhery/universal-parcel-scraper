import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment, type AdapterFactory, type CarrierAdapter } from '../core/adapter/index.js';
import { InvalidInputError, NotFoundError, RateLimitedError, SchemaError, UpstreamNetworkError } from '../core/errors/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../core/transport/userAgent.js';
import { createTracker, TrackingError } from './index.js';

const number = '1Z999AA10123456784';
const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
function registry(track: CarrierAdapter['track'], recordsSteps = false): AdapterRegistry {
  const factory: AdapterFactory = () => ({ id: 'ups', steps: ['direct'], recordsSteps, track });
  return new AdapterRegistry({ factories: { ups: factory }, carriers: { ups: 'ups' } }, environment);
}

// A number whose shape fits several carriers; these four can be asked whether they know it.
const ambiguous = '06080000000002';
const hung = () => new Promise<never>(() => {});
function recognizers(recognize: Record<string, NonNullable<CarrierAdapter['recognize']>>, track: CarrierAdapter['track'] = hung): AdapterRegistry {
  const carriers = Object.keys(recognize);
  return new AdapterRegistry({
    factories: Object.fromEntries(carriers.map(id => [id, (): CarrierAdapter => ({ id, steps: ['direct'], track, recognize: recognize[id] })])),
    carriers: Object.fromEntries(carriers.map(id => [id, id])),
  }, environment);
}

describe('standalone tracker', () => {
  it('detects locally and resolves stages without inventing local-clock instants', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
      { local_time: '2026-01-01T12:00:00', description: 'In transit' },
    ] });
    const tracker = createTracker({ registry: registry(lookup), providers: [] });
    expect(tracker.detect(number)).toMatchObject({ carrier: 'ups', confidence: 'high' });
    const answer = await tracker.track({ number });
    expect(answer).toMatchObject({ carrier: 'ups', source: 'ups', result: { current_stage: 'delivered', events: [
      { stage: 'delivered', instant: '2026-01-02T12:00:00Z' }, { instant: null },
    ] }, attempts: [{ source: 'ups', kind: 'ok' }] });
    expect(lookup.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('records a single-step lookup once, leaving it to an adapter that records its own steps', async () => {
    const lookups: string[] = [];
    const recorder = { step() {}, lookup: ({ carrier }: { carrier: string }) => { lookups.push(carrier); } };
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
    ] });
    await createTracker({ registry: registry(lookup), providers: [], recorder }).track({ number });
    expect(lookups).toEqual(['ups']);
    await createTracker({ registry: registry(lookup, true), providers: [], recorder }).track({ number });
    expect(lookups).toEqual(['ups']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('confirms the direct carrier for a generic postal number before tracking', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: new Date().toISOString(), description: 'Delivered', stage: 'delivered' },
    ] });
    const posti = vi.fn().mockResolvedValue({ known: true });
    const chronopost = vi.fn().mockResolvedValue({ known: false });
    const tracker = createTracker({ providers: [], registry: recognizers({ posti, chronopost }, lookup) });
    expect(tracker.detect('RR123456785FI')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    await expect(tracker.track({ number: 'RR123456785FI' })).resolves.toMatchObject({
      carrier: 'posti', source: 'posti', attempts: [{ source: 'posti', kind: 'ok' }],
    });
    expect(posti).toHaveBeenCalledOnce();
    expect(chronopost).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('keeps commercial providers off unless selected', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    await expect(createTracker({ registry: registry(lookup), fetcher }).track({ number }))
      .rejects.toMatchObject({ hint: { kind: 'not_found' }, attempts: [{ source: 'ups', kind: 'not_found' }] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createTracker({ providers: ['Unknown' as never] })).toThrow(TypeError);
  });

  it('uses an explicitly selected fallback after a failed direct lookup', async () => {
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {
      tracking_number: number, events: [{ timestamp: '2026-01-02T12:00:00Z', status: 'Delivered', dispatch_code_id: 7 }],
    } }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const answer = await createTracker({ registry: registry(lookup), fetcher, providers: ['Ship24'] }).track({ number });
    expect(answer.source).toBe('Ship24');
    expect(answer.attempts.map(attempt => attempt.kind)).toEqual(['not_found','ok']);
    expect(fetcher).toHaveBeenCalled();
  });

  it('forwards a country hint through the public tracker into empty-history recovery', async () => {
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'NO_DATA' }))
      .mockResolvedValueOnce(Response.json({ states: [{ date: '2026-01-02T12:00:00Z', status: 'Delivered' }] }));
    const answer = await createTracker({ registry: registry(lookup), fetcher, providers: ['ParcelsApp'] })
      .track({ number, countryHint: 'FR' });
    expect(answer.source).toBe('ParcelsApp');
    expect(answer.result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('extra[manualCountry]')).toBe('France');
    expect(answer.result.destination_country).toBeUndefined();
  });

  it('enforces a single deadline even when an adapter ignores cancellation', async () => {
    const lookup = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(createTracker({ registry: registry(lookup), providers: [] }).track({ number }, { budgetMs: 20 }))
      .rejects.toMatchObject({ hint: { kind: 'budget' } });
  });

  it('honors a caller cancellation without starting a new provider', async () => {
    const lookup = vi.fn().mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const fetcher = vi.fn<typeof fetch>();
    const result = createTracker({ registry: registry(lookup), providers: ['Ship24'], fetcher }).track({ number }, { signal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes cancellation into legacy HTTP transports through the lookup context', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<never>((_, reject) => {
        init!.signal!.throwIfAborted();
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
      throw new Error('Unreachable');
    });
    const pending = createTracker({ fetcher, providers: [] }).track({ number }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('returns the carriers that answered when others have not by the budget', async () => {
    const waiting = vi.fn<NonNullable<CarrierAdapter['recognize']>>().mockImplementation(hung);
    const tracker = createTracker({ providers: [], registry: recognizers({
      dpd: async () => ({ known: true }), seur: waiting, brt: async () => ({ known: false }),
      ciblex: async () => { throw new SchemaError('Ciblex'); },
    }) });
    const answer = { carrier: 'dpd', choices: [], asked: ['dpd', 'seur', 'brt', 'ciblex'], unanswered: ['seur', 'ciblex'] };
    await expect(tracker.recognize(ambiguous, { budgetMs: 30 })).resolves.toEqual(answer);
    // The budget still cancels what was in flight.
    expect(waiting.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    // A caller's signal that stays quiet changes nothing.
    await expect(tracker.recognize(ambiguous, { budgetMs: 30, signal: new AbortController().signal })).resolves.toEqual(answer);
  });

  it('tracks with the carrier that answered once recognition has waited long enough for the others', async () => {
    vi.useFakeTimers();
    // Put the budget signals on the same faked clock as the recognition deadline.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => { controller.abort(new DOMException('The operation timed out', 'TimeoutError')); }, ms);
      return controller.signal;
    });
    try {
      const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
        { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
      ] });
      const tracker = createTracker({ providers: [], registry: recognizers({
        dpd: async () => ({ known: true }), seur: hung, brt: async () => ({ known: false }), ciblex: async () => ({ known: false }),
      }, lookup) });
      const pending = tracker.track({ number: ambiguous });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ carrier: 'dpd', source: 'dpd', attempts: [{ source: 'dpd', kind: 'ok' }] });
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('rejects a recognition the caller cancels, and reports a budget spent on it as a tracking failure', async () => {
    const tracker = createTracker({ providers: [], registry: recognizers({ dpd: hung, seur: hung, brt: hung, ciblex: hung }) });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = tracker.recognize(ambiguous, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // Whatever else the caller supplied, no source was asked: the budget is the failure.
    for (const input of [{ number: ambiguous }, { number: ambiguous, postcode: '8000' }]) {
      const failure = await tracker.track(input, { budgetMs: 30 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TrackingError);
      expect(failure).toMatchObject({ attempts: [], hint: { kind: 'budget' } });
    }
  });

  it('validates carrier-specific credentials before any lookup', async () => {
    const lookup = vi.fn();
    const tracker = createTracker({ registry: registry(lookup) });
    await expect(tracker.track({ number, trackingUrl: 'https://private.invalid/secret' })).rejects.toBeInstanceOf(TypeError);
    await expect(tracker.track({ number, postcode: 'secret' })).rejects.toBeInstanceOf(TypeError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports a spent deadline as a budget failure when the source ends on the same budget, and asks no fallback', async () => {
    // What adapters do with the budget they are handed: their own timer, joined with the caller's signal.
    const lookup: CarrierAdapter['track'] = (_input, context) => new Promise((_, reject) => {
      const ended = AbortSignal.any([context!.signal!, AbortSignal.timeout(Math.floor(context!.budgetMs!))]);
      ended.addEventListener('abort', () => reject(new UpstreamNetworkError('UPS', ended.reason)), { once: true });
    });
    const fetcher = vi.fn<typeof fetch>();
    for (const recordsSteps of [false, true]) {
      await expect(createTracker({ registry: registry(lookup, recordsSteps), providers: ['Ship24'], fetcher }).track({ number }, { budgetMs: 60 }))
        .rejects.toMatchObject({ hint: { kind: 'budget' }, attempts: [{ source: 'ups', kind: 'budget' }] });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps an earlier source\'s failure as the hint when a later source only refuses the number\'s format', async () => {
    const composite = '1234/12345678';
    const nacex = (error: Error) => new AdapterRegistry({ factories: { nacex: () => ({ id: 'nacex', steps: ['direct'],
      track: vi.fn().mockRejectedValue(error) }) }, carriers: { nacex: 'nacex' } }, environment);
    const failure = (error: Error) => createTracker({ registry: nacex(error), providers: ['Ship24'], fetcher: vi.fn<typeof fetch>() })
      .track({ number: composite, carrier: 'nacex' }).then(() => null, (reason: TrackingError) => reason);
    expect(await failure(new RateLimitedError('NACEX', 30_000))).toMatchObject({
      hint: { kind: 'rate_limited', retryAfterMs: 30_000 }, attempts: [{ source: 'nacex', kind: 'rate_limited' }, { source: 'Ship24', kind: 'invalid_input' }],
    });
    // A direct adapter that refuses the format itself is still the answer.
    expect(await failure(new InvalidInputError('NACEX'))).toMatchObject({ hint: { kind: 'invalid_input' } });
  });

  it('tells a rejected number and a malformed reply apart from a transport failure', async () => {
    const hintOf = async (error: Error) => createTracker({ registry: registry(vi.fn().mockRejectedValue(error)), providers: [] })
      .track({ number }).then(() => null, (failure: TrackingError) => ({ hint: failure.hint.kind, attempt: failure.attempts[0]?.kind }));
    expect(await hintOf(new InvalidInputError('UPS'))).toEqual({ hint: 'invalid_input', attempt: 'invalid_input' });
    expect(await hintOf(new TypeError('Cannot read properties of undefined'))).toEqual({ hint: 'schema', attempt: 'schema' });
    expect(await hintOf(new Error('socket closed'))).toEqual({ hint: 'transport', attempt: 'transport' });
  });

  it('names the install to carriers with the host User-Agent and rejects an unusable one', async () => {
    const sent = async (userAgent?: string) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 }));
      await createTracker({ userAgent, fetcher, providers: [] }).track({ number: '6A00000000000', carrier: 'la-poste' }).catch(() => {});
      return new Headers(fetcher.mock.calls[0]![1]!.headers).get('user-agent');
    };
    expect(await sent('ExampleHost/1.0')).toBe('ExampleHost/1.0');
    expect(await sent()).toBe(DEFAULT_USER_AGENT);
    expect(() => createTracker({ userAgent: 'Example\r\nX-Injected: 1' })).toThrow(TypeError);
  });

  it('exposes a safe aggregate error without adapter diagnostics', async () => {
    const lookup = vi.fn().mockRejectedValue(new SchemaError('UPS', 'private payload'));
    try { await createTracker({ registry: registry(lookup), providers: [] }).track({ number }); }
    catch (error) {
      expect(error).toBeInstanceOf(TrackingError);
      expect(JSON.stringify(error)).not.toContain('private payload');
      expect(error).toMatchObject({ hint: { kind: 'schema' } });
      return;
    }
    throw new Error('Expected tracking failure');
  });
});
