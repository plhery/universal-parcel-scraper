import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { GREENWAY_LOGS, normalizeGreenwayNumber, parseGreenway } from './parser.js';
import { statusMap } from './status.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const reply = fixture('in-transit.json') as { packages: Record<string, unknown>[]; logs: Record<string, unknown>[] };
const number = 'G0000512000433544';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const withPackage = (extra: Record<string, unknown>, logs: unknown[] = reply.logs) => ({ packages: [{ ...reply.packages[0], ...extra }], logs });

describe('Greenway codes', () => {
  it('takes the code with spaces or in lower case', () => {
    expect(normalizeGreenwayNumber(' g0000 5120 00433544 ')).toBe(number);
    expect(() => normalizeGreenwayNumber('G/0001')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('posts the code to its logs lookup as the tracking page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(reply));
    const result = await tracker(fetcher).track({ number });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(GREENWAY_LOGS);
    expect(String(init?.body)).toBe('{"codes":["G0000512000433544"]}');
    expect(new Headers(init?.headers).get('origin')).toBe('https://greenwayvn.com');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', provider_code: 'in-transit', last_update: '2022-03-22T13:59:37Z', destination_country: 'US',
    });
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('names USPS for the last mile when its rules take the number', () => {
    expect(parseGreenway(reply, number)).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9200100000000000841168' });
    // Synthetic: a last-mile carrier the reader does not know keeps only its number.
    const other = parseGreenway(withPackage({ tracking: { tracking_number: '9200100000000000841168', last_mile_carrier: 'Example' } }), number);
    expect(other.delivery_tracking_number).toBe('9200100000000000841168');
    expect(other).not.toHaveProperty('delivery_carrier');
    const none = parseGreenway(withPackage({ tracking: { tracking_number: '', last_mile_carrier: '' } }), number);
    expect(none).not.toHaveProperty('delivery_tracking_number');
  });

  it('keeps the hand-over when the package has no logs yet', () => {
    expect(() => parseGreenway(withPackage({}, []), number)).toThrow(expect.objectContaining({
      kind: 'indeterminate', reason: 'listed', deliveryCarrier: 'usps', deliveryTrackingNumber: '9200100000000000841168',
    }));
  });

  it('reads the delivery clock of a delivered package, and not an unset one', () => {
    const delivered = parseGreenway(withPackage({ status_string: 'delivered', delivered_at: '2022-03-30T18:04:00Z' }), number);
    expect(delivered).toMatchObject({ current_stage: 'delivered', delivered_at: '2022-03-30T18:04:00Z' });
    const unset = parseGreenway(withPackage({ status_string: 'delivered' }), number);
    expect(unset).not.toHaveProperty('delivered_at');
    expect(parseGreenway(withPackage({ status_string: 'processing' }), number).current_stage).toBe('in_transit');
    expect(parseGreenway(withPackage({ status_string: 'created' }, reply.logs.slice(3)), number).current_stage).toBe('registered');
  });

  it('answers its statuses by the code and wording its statuses.json records', () => {
    const { entries } = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as
      { entries: { code?: string | null; wording?: string | null; stage?: string | null }[] };
    for (const { code, wording, stage } of entries) {
      expect(statusMap.stage(code ?? null, wording ?? ''), `${code ?? ''} ${wording ?? ''}`).toBe(stage ?? undefined);
    }
    // The Human Express's wordings name its own processing center.
    expect(statusMap.stage(null, 'accepted at the processing center')).toBeUndefined();
  });

  it('reports a code the lookup does not hold as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(readFileSync(new URL('./fixtures/not-found.json', import.meta.url)), { status: 400 }));
    await expect(tracker(fetcher).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
