import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const NUMBER = '01000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as Record<string, unknown>;
function tracking(fetcher: typeof fetch) {
  return adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
}
function guest(reply: Response) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }))
    .mockResolvedValueOnce(Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } }))
    .mockResolvedValueOnce(Response.json({ access_token: 'synthetic-access', expires_in: 3600 }))
    .mockResolvedValueOnce(reply);
}

describe('DPD Germany guest tracking', () => {
  it('selects Germany without changing parcel identity and omits recipient data', async () => {
    const fetcher = guest(Response.json(fixture));
    const result = await tracking(fetcher).track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'delivered', tracking_url: `https://tracking.dpd.de/status/en_US/parcel/${NUMBER}` });
    expect(result.events).toHaveLength(4);
    const url = new URL(String(fetcher.mock.calls[3]![0]));
    expect(url.searchParams.get('businessUnit')).toBe('DPD-DE');
    expect(url.searchParams.get('continueWithoutVerification')).toBe('true');
    expect(result).not.toHaveProperty('receiver');
    expect(result.events?.[0]?.time).toBe('2026-07-16T10:12:00+02:00');
    expect(tracking(fetcher).steps).toEqual(['direct']);
  });

  it('rejects another country rather than letting a group-wide match establish Germany', async () => {
    const payload = structuredClone(fixture);
    (payload.status as Record<string, unknown>).countryCode = 'CH';
    const fetcher = guest(Response.json(payload));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects a mismatched parcel identity', async () => {
    const fetcher = guest(Response.json({ ...fixture, parcelNumber: '01000000000002' }));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: 'identity alone', payload: { parcelNumber: NUMBER }, kind: 'schema' },
    { name: 'empty history', payload: { ...fixture, parcelHistory: [] }, kind: 'indeterminate' },
    { name: 'missing history', payload: { ...fixture, parcelHistory: undefined }, kind: 'indeterminate' },
    { name: 'history object', payload: { ...fixture, parcelHistory: {} }, kind: 'schema' },
    { name: 'invalid history row', payload: { ...fixture, parcelHistory: [null] }, kind: 'schema' },
    { name: 'undated history row', payload: { ...fixture, parcelHistory: [{ description: 'PARCEL_HANDED' }] }, kind: 'schema' },
    { name: 'unworded history row', payload: { ...fixture, parcelHistory: [{ eventDateAndTime: '2026-07-15T10:00:00' }] }, kind: 'schema' },
    { name: 'invalid event date', payload: { ...fixture, parcelHistory: [{ description: 'PARCEL_HANDED', eventDateAndTime: '2026-02-30T10:00:00' }] }, kind: 'schema' },
  ])('rejects $name rather than manufacturing tracking success', async ({ payload, kind }) => {
    const fetcher = guest(Response.json(payload));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('accepts five-digit postcodes and rejects Swiss-sized inputs before requesting', async () => {
    const fetcher = guest(Response.json(fixture));
    await tracking(fetcher).track({ number: NUMBER, postcode: '00000' });
    expect(new URL(String(fetcher.mock.calls[3]![0])).searchParams.get('dataForVerification')).toBe('00000');
    const unused = vi.fn<typeof fetch>();
    await expect(tracking(unused).track({ number: NUMBER, postcode: '0000' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('never enters the Swiss page when guest authentication fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }));
    await expect(tracking(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation to the guest protocol', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      requestSignal = signal;
      signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
    const result = tracking(fetcher).track({ number: NUMBER }, { signal: controller.signal, budgetMs: 1000 });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort(new Error('Cancelled'));
    await expect(result).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('ends the guest request inside the caller budget', async () => {
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), { once: true });
    });
    await expect(tracking(fetcher).track({ number: NUMBER }, { budgetMs: 15 }))
      .rejects.toMatchObject({ kind: 'budget' });
  });
});
