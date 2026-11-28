import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { packageLogsBody } from './packageLogs.js';
import { normalizeTheHumanNumber, parseTheHuman, THE_HUMAN_LOGS } from './parser.js';
import { statusMap } from './status.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const reply = fixture('in-transit.json') as { packages: Record<string, unknown>[]; logs: Record<string, unknown>[] };
const number = 'THE0000512000433544';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const withPackage = (extra: Record<string, unknown>, logs: unknown[] = reply.logs) => ({ packages: [{ ...reply.packages[0], ...extra }], logs });
const refused = (error: string) => new Response(JSON.stringify({ error }), { status: 400, headers: { 'content-type': 'application/json' } });

describe('The Human Express codes', () => {
  it('takes the code with spaces, hyphens or in lower case', () => {
    expect(normalizeTheHumanNumber(' the0000-5120 00433544 ')).toBe(number);
    expect(normalizeTheHumanNumber('the0000712001132106sb')).toBe('THE0000712001132106SB');
    expect(() => normalizeTheHumanNumber('THE/0001')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('posts the code to the logs lookup as the tracking page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(reply));
    const result = await tracker(fetcher).track({ number: 'the0000512000433544' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(THE_HUMAN_LOGS);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe('{"codes":["THE0000512000433544"]}');
    expect(packageLogsBody(number)).toBe(String(init?.body));
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init?.headers).get('origin')).toBe('https://thehuman.express');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', provider_code: 'in-transit',
      last_status_text: 'Arriving at international airport to go abroad', last_update: '2022-03-22T13:59:37Z', destination_country: 'US',
    });
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads the logs newest first, as instants, with their places and stages', () => {
    const { events = [] } = parseTheHuman({ ...reply, logs: [...reply.logs].reverse() }, number);
    expect(events.map((event) => [event.time, event.stage])).toEqual([
      ['2022-03-22T13:59:37Z', 'in_transit'],
      ['2022-03-22T13:59:29Z', 'in_transit'],
      ['2022-03-22T13:55:48Z', 'accepted'],
      ['2022-03-22T13:55:17Z', 'registered'],
    ]);
    expect(events[0]).toMatchObject({ location: 'Hanoi, VN', stage_source: 'carrier_map' });
    expect(events[3]).not.toHaveProperty('location');
  });

  it('takes the stage from the package status, unless the newest staged log is further along', () => {
    // Synthetic: a package the page files under pre-transit, whose newest log is its acceptance.
    const accepted = parseTheHuman(withPackage({ status_string: 'pre-transit' }, reply.logs.slice(2)), number);
    expect(accepted).toMatchObject({ current_stage: 'accepted', status: 'in_transit', provider_code: 'pre-transit' });
    const delivered = parseTheHuman(withPackage({ status_string: 'delivered' }), number);
    expect(delivered).toMatchObject({ current_stage: 'delivered', status: 'delivered', current_stage_source: 'carrier_map' });
    const canceled = parseTheHuman(withPackage({ status_string: 'canceled' }), number);
    expect(canceled).toMatchObject({ current_stage: 'exception' });
    // An archived package keeps the stage of its logs.
    const archived = parseTheHuman(withPackage({ status_string: 'archived' }), number);
    expect(archived).toMatchObject({ current_stage: 'in_transit', provider_code: 'archived' });
  });

  it('reads an alert that the package was sent back as a return, and a slow one as nothing', () => {
    expect(parseTheHuman(withPackage({ alert: 3 }), number)).toMatchObject({ current_stage: 'returned', status: 'exception' });
    expect(parseTheHuman(withPackage({ alert: 2 }), number)).toMatchObject({ current_stage: 'returned' });
    expect(parseTheHuman(withPackage({ alert: 1 }), number)).toMatchObject({ current_stage: 'in_transit' });
    expect(parseTheHuman(withPackage({ alert: null }), number)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads a log the map does not know by the shared wording rules, or leaves it without a stage', () => {
    // Synthetic logs after the documentation's last one.
    const later = (description: string) => parseTheHuman(withPackage({}, [
      { package_id: 43354, ship_time: '2022-03-25T08:00:00Z', location: 'Example City, CA', description }, ...reply.logs]), number);
    expect(later('Synthetic note').events?.[0]).not.toHaveProperty('stage');
    expect(later('Synthetic note').current_stage).toBe('in_transit');
    expect(later('Out for Delivery').events?.[0]).toMatchObject({ stage: 'out_for_delivery' });
    expect(later('Out for Delivery').current_stage).toBe('out_for_delivery');
  });

  it('answers its statuses by the code and wording its statuses.json records', () => {
    const { entries } = fixtureEntries();
    for (const { code, wording, stage } of entries) {
      expect(statusMap.stage(code ?? null, wording ?? ''), `${code ?? ''} ${wording ?? ''}`).toBe(stage ?? undefined);
    }
    expect(statusMap.gaps.map(({ code }) => code)).toEqual(['archived', 'alert:1']);
  });

  it('reports a code the lookup does not hold as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(readFileSync(new URL('./fixtures/not-found.json', import.meta.url)), { status: 400 }));
    await expect(tracker(fetcher).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseTheHuman({ packages: [], logs: [] }, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('requires the package asked before reading its logs, and reads only that package’s logs', () => {
    expect(() => parseTheHuman(reply, 'THE0000512000433545')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = parseTheHuman({ ...reply, logs: [...reply.logs, { package_id: 1, ship_time: '2022-03-30T00:00:00Z', description: 'Delivered' }] }, number);
    expect(other.events).toHaveLength(4);
  });

  it('does not take a refusal, a changed reply or a verification page for a missing code', async () => {
    await expect(tracker(vi.fn<typeof fetch>().mockResolvedValueOnce(refused('Please check input data'))).track({ number }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseTheHuman({ packages: 'none' }, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTheHuman(withPackage({ status_string: 'In Transit!' }), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTheHuman(withPackage({}, [{ package_id: 43354, ship_time: '2022-03-22 13:59:37', description: 'x' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTheHuman(withPackage({}, [{ package_id: 43354, ship_time: '0001-01-01T00:00:00Z', description: 'x' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTheHuman(withPackage({}, []), number)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><head><title>Just a moment...</title></head></html>'));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/' } }));
    await expect(tracker(moved).track({ number })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('recognizes a code the lookup holds, and not one it does not', async () => {
    const held = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(reply));
    await expect(tracker(held).recognize!(number)).resolves.toMatchObject({ known: true });
    const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(refused('Không tìm thấy'));
    await expect(tracker(missing).recognize!(number)).resolves.toMatchObject({ known: false });
  });
});

function fixtureEntries(): { entries: { code?: string | null; wording?: string | null; stage?: string | null }[] } {
  return JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as ReturnType<typeof fixtureEntries>;
}
