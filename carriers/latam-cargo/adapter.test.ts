import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LATAM_LOOKUP } from './adapter.js';
import { normalizeLatamNumber, parseLatam } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import { statusMap } from './status.js';

// The public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = '957-52555440';
const UNKNOWN = '957-00000011';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered-domestic');
const NOT_FOUND = fixture('not-found');
// The tracker serves ISO-8859-1, as its header says.
const page = (body: string, init: ResponseInit = {}) => new Response(Buffer.from(body, 'latin1'), {
  ...init, headers: { 'Content-Type': 'text/html;charset=ISO-8859-1', ...init.headers },
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const sentBody = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number) => JSON.parse(String(fetcher.mock.calls[call]![1]!.body));

describe('LATAM Cargo numbers', () => {
  it('takes a three-digit prefix and an eight-digit serial, with or without a hyphen or spaces', () => {
    expect(normalizeLatamNumber('957-52555440')).toEqual({ prefix: '957', serial: '52555440', label: '957-52555440' });
    expect(normalizeLatamNumber(' 957 5255 5440 ')).toMatchObject({ label: '957-52555440' });
    expect(normalizeLatamNumber('95752555440')).toMatchObject({ label: '957-52555440' });
    for (const raw of ['52555440', '957-5255544', '957-525554400', 'LA-52555440', '']) {
      expect(() => normalizeLatamNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('LATAM Cargo replies', () => {
  it('reads the public sample: events newest first on station wall clocks, delivered at the destination', () => {
    const result = parseLatam(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: null, last_update_local: '2024-08-12T13:59',
    });
    expect(result.events).toHaveLength(11);
    // A departure the table files after the delivery stays in the history without reopening it.
    expect(result.events![0]).toMatchObject({ local_time: '2024-08-14T09:15', description: 'Flight Departed', location: 'SJK', provider_code: 'DEP', stage: 'in_transit' });
    expect(result.events![1]).toMatchObject({ local_time: '2024-08-12T13:59', description: 'Shipment Delivered', location: 'MAO', stage: 'delivered' });
    expect(result.events!.find((event) => event.provider_code === 'HLD03')).toMatchObject({
      description: 'LIBERADO PELA FISCALIZAÇÃO (LOTE COMPLETO)', stage: 'in_transit', location: 'MAO',
    });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2024-07-26T18:24', description: 'Shipment Received', location: 'SJK', stage: 'accepted' });
    expect(result.events!.some((event) => event.time)).toBe(false);
    // The delivery row's last column names who received it; it is never read.
    expect(JSON.stringify(result)).not.toContain('RECIPIENT NAME');
  });

  it('keeps a delivery of fewer pieces than the shipment in transit', () => {
    const split = DELIVERED.replace('<td id="totalPieces">1</td>', '<td id="totalPieces">2</td>');
    expect(parseLatam(split, SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Flight Departed' });
  });

  it('requires the document asked in the reply', () => {
    expect(() => parseLatam(DELIVERED, '957-12345675')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a changed event table or a missing time as a malformed reply', () => {
    expect(() => parseLatam(DELIVERED.replace('<th>Actual Time</th>', '<th>Time</th>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLatam(DELIVERED.replace('26-Jul-2024 18:24', '26/07/2024'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every recorded code', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
  });
});

describe('LATAM Cargo adapter', () => {
  it('asks for an international air waybill, then a domestic service order, and reads the one that answers', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page(NOT_FOUND))
      .mockResolvedValueOnce(page(DELIVERED));
    const result = await carrier(fetcher).track({ number: SAMPLE });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(LATAM_LOOKUP);
    expect(fetcher.mock.calls[0]![1]!.method).toBe('POST');
    expect(sentBody(fetcher, 0)).toEqual({ cargoTrackingRequestSOs: [{ documentPrefix: '957', documentNumber: '52555440', documentType: 'MAWB' }] });
    expect(sentBody(fetcher, 1)).toEqual({ cargoTrackingRequestSOs: [{ documentPrefix: '957', documentNumber: '52555440', documentType: 'SO' }] });
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2024-08-12T13:59' });
    expect(result.events!.find((event) => event.provider_code === 'HLD03')!.description).toBe('LIBERADO PELA FISCALIZAÇÃO (LOTE COMPLETO)');
  });

  it('reads not found only when both document types get the lookup\'s own answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(NOT_FOUND));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a browser check, a refusal or a rate limit as such, never as not found', async () => {
    const check = vi.fn<typeof fetch>().mockResolvedValue(page('<html><title>Just a moment...</title></html>'));
    await expect(carrier(check).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'challenge' });
    const refused = vi.fn<typeof fetch>().mockResolvedValue(page('<html><title>403 Forbidden</title></html>', { status: 403 }));
    await expect(carrier(refused).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'challenge' });
    const limited = vi.fn<typeof fetch>().mockResolvedValue(page('Too many requests', { status: 429 }));
    await expect(carrier(limited).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('reads an unexpected page as a malformed reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page('<html><body>Maintenance window</body></html>'));
    await expect(carrier(fetcher).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('rejects a number without a prefix before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '52555440' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
