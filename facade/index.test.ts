import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment, type AdapterFactory, type CarrierAdapter } from '../core/adapter/index.js';
import { NotFoundError, SchemaError } from '../core/errors/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { createTracker, TrackingError } from './index.js';

const number = '1Z999AA10123456784';
const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
function registry(track: CarrierAdapter['track'], recordsSteps = false): AdapterRegistry {
  const factory: AdapterFactory = () => ({ id: 'ups', steps: ['direct'], recordsSteps, track });
  return new AdapterRegistry({ factories: { ups: factory }, carriers: { ups: 'ups' } }, environment);
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
    expect(lookup.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
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
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('validates carrier-specific credentials before any lookup', async () => {
    const lookup = vi.fn();
    const tracker = createTracker({ registry: registry(lookup) });
    await expect(tracker.track({ number, trackingUrl: 'https://private.invalid/secret' })).rejects.toBeInstanceOf(TypeError);
    await expect(tracker.track({ number, postcode: 'secret' })).rejects.toBeInstanceOf(TypeError);
    expect(lookup).not.toHaveBeenCalled();
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
