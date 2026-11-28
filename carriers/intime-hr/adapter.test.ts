import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, IN_TIME_TRACKING } from './adapter.js';
import { normalizeInTimeNumber, parseInTime } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const delivered = fixture('delivered.json') as { events: Record<string, unknown>[] } & Record<string, unknown>;
const number = 'HR200026347135';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const withEvents = (events: unknown) => ({ ...delivered, events });

describe('In Time Croatia shipment numbers', () => {
  it('takes HR and twelve digits, in any case and with spaces', () => {
    expect(normalizeInTimeNumber(' hr 2000 2634 7135 ')).toBe(number);
    expect(() => normalizeInTimeNumber('200026347135')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeInTimeNumber('HR20002634713')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeInTimeNumber('SI200026347135')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('asks the tracking API with the number alone, as the page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
    const result = await tracker(fetcher).track({ number: 'hr200026347135' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${IN_TIME_TRACKING}?id=${number}`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-07-01T11:09:23', destination_country: 'HR',
    });
    // The route's towns are the sender's and the recipient's.
    expect(JSON.stringify(result)).not.toMatch(/Matulji/);
  });

  it('reads the rows newest first on Croatia\'s wall clock, by their English wording and code', () => {
    const { events = [] } = parseInTime(delivered, number);
    expect(events.map((event) => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-07-01T11:09:23', 'ST07', 'Delivered', 'RIJEKA', 'delivered'],
      ['2026-07-01T09:06:23', 'ST05', 'On IN TIME vehicle for delivery', 'RIJEKA', 'out_for_delivery'],
      ['2026-06-30T15:04:56', 'ST04', 'At local IN TIME facility', 'RIJEKA', 'in_transit'],
      ['2026-06-30T11:04:23', 'ST02', 'Picked Up', 'RIJEKA', 'accepted'],
      ['2026-06-30T10:03:19', 'ST01', 'Shipment information sent to InTime', 'RIJEKA', 'registered'],
    ]);
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('stages every recorded code by the map, and an unknown code by its English wording', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
    // Synthetic: a code the map does not know, with a label the shared rules read.
    const result = parseInTime(withEvents([...delivered.events.slice(0, 3),
      { eventDate: '2026-07-01T08:00:00', statusCode: 'ST99', statusLabel: 'Neuspješna dostava (Delivery attempt failed)', location: 'RIJEKA' }]), number);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'ST99', description: 'Delivery attempt failed', stage_source: expect.stringMatching(/^wording:/) });
    // Synthetic: a label without its English half stays whole.
    const plain = parseInTime(withEvents([{ eventDate: '2026-07-01T08:00:00', statusCode: 'ST98', statusLabel: 'Napomena', location: '' }]), number);
    expect(plain.events?.[0]).toMatchObject({ description: 'Napomena', provider_code: 'ST98' });
    expect(plain.events?.[0]).not.toHaveProperty('location');
  });

  it('reports a number the API does not hold as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture('not-found.json'), { status: 404 }));
    await expect(tracker(fetcher).track({ number: 'HR990000000017' })).rejects.toMatchObject({ kind: 'not_found' });
    // The same error on another status, or another error, is no answer about the number.
    expect(() => parseInTime(fixture('not-found.json'), number, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInTime({ error: 'Missing or invalid tracking number' }, number, 400)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a shipment without rows as listed', () => {
    expect(() => parseInTime(withEvents([]), number)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('does not take a failure, a changed reply or a verification page for a missing shipment', async () => {
    expect(() => parseInTime({ shipFromCountry: 'HR' }, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInTime(withEvents('none'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInTime(withEvents([{ eventDate: '30.06.2026. 10:03', statusCode: 'ST01', statusLabel: 'Nalog Kreiran' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInTime(withEvents([{ eventDate: '2026-02-30T10:03:19', statusCode: 'ST01', statusLabel: 'Nalog Kreiran' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInTime(withEvents([{ eventDate: '2026-06-30T10:03:19', statusCode: '<b>', statusLabel: 'Nalog Kreiran' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 }));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><body>Forbidden</body></html>', { status: 403 }));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const page = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><body>Praćenje</body></html>', { status: 200 }));
    await expect(tracker(page).track({ number })).rejects.toMatchObject({ kind: 'schema' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
    await expect(tracker(down).track({ number })).rejects.not.toMatchObject({ kind: 'not_found' });
  });
});
