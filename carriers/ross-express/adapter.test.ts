import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ROSS_TRACE, rossTraceUrl } from './adapter.js';
import { normalizeRossNumber, parseRossTrace } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented PRO of the not-found reply.
const PRO = '6378333';
const UNKNOWN = '0000001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'latin1');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const xml = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/xml', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const failing = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(xml(body, init))).track({ number: PRO });
/** The delivered reply with its history rows replaced. */
const withRows = (rows: string, reply = DELIVERED) => reply.replace(/<shiphists>[\s\S]*<\/shiphists>/, `<shiphists>${rows}</shiphists>`);
const row = (code: string, date: string, time: string, remarks: string) =>
  `<shiphist><histcode>${code}</histcode><histdate>${date}</histdate><histtime>${time}</histtime><histremarks>${remarks}</histremarks></shiphist>`;
/** The delivered reply as a shipment still on its way. */
const MOVING = DELIVERED.replace('<prodelivered>Yes</prodelivered>', '<prodelivered>No</prodelivered>')
  .replace('<lifecycle>Delivered</lifecycle>', '<lifecycle></lifecycle>')
  .replace('<lifecyclestatuscode>80</lifecyclestatuscode>', '<lifecyclestatuscode></lifecyclestatuscode>');

describe('Ross Express numbers', () => {
  it('takes six or seven digits as typed', () => {
    expect(normalizeRossNumber(` ${PRO.slice(0, 3)} ${PRO.slice(3)} `)).toBe(PRO);
    expect(normalizeRossNumber(UNKNOWN)).toBe(UNKNOWN);
    for (const other of ['', '12345', '0000000', '12345678', 'RX6378333', `${PRO},${UNKNOWN}`, '1'.repeat(65)]) {
      expect(() => normalizeRossNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Ross Express tracking adapter', () => {
  it('asks the XML trace for the PRO once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(xml(DELIVERED));
    await expect(carrier(fetcher).track({ number: PRO })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${ROSS_TRACE}?pronum=${PRO}`);
    expect(rossTraceUrl(PRO)).toBe('https://tracking.carrierlogistics.com/scripts/rxic.pol/protracexml.htm?pronum=6378333');
  });

  it('reads the delivered public sample with its wall clocks and without the signer', () => {
    const result = parseRossTrace(DELIVERED, PRO);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2021-11-24T12:59:00', weight_kg: 27.216,
      events: [
        { local_time: '2021-11-24T12:59:00', location: 'Willimantic, CT', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2021-11-24T08:27:00', location: 'Auburn, MA', description: 'Out For Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2021-11-24T08:27:00', location: 'Auburn, MA', description: 'Loaded On Trailer', stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/SIGNER|SHIPPER|Etobicoke|M9C/);
  });

  it('reads the trace’s answer naming the PRO as not found, and one naming another as inconclusive', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(xml(NOT_FOUND))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(failing(NOT_FOUND)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failing(NOT_FOUND.replace('Invalid pronumber 0000001', 'Invalid user'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('never reads another shipment, a rate quote or a reply that did not run as the PRO’s', async () => {
    // Synthetic: a number the trace does not hold as a PRO can match another shipment's reference.
    await expect(failing(DELIVERED.replace(`<pronumb>${PRO}</pronumb>`, '<pronumb>6926311</pronumb>'))).rejects.toMatchObject({ kind: 'indeterminate' });
    const quote = withRows('', DELIVERED).replace('<lifecycle>Delivered</lifecycle>', '<lifecycle>Quote</lifecycle>')
      .replace('<lifecyclestatuscode>80</lifecyclestatuscode>', '<lifecyclestatuscode>0</lifecyclestatuscode>');
    await expect(failing(quote)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failing('<html><title>WebSpeed error</title></html>')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failing(' ')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps block pages, moved routes and changed replies apart from a missing shipment', async () => {
    await expect(failing('<html><title>Just a moment...</title></html>', { status: 200 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(failing('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(failing('', { status: 302, headers: { Location: '/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(failing('<html>Ross</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(failing(DELIVERED.replace('<pronumb>', '<pronumb>6378333</pronumb><pronumb>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(failing(withRows(row('Delivered', '11/24/2021', '12:59', 'Willimantic, CT')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(failing(withRows(row('Delivered', '2021-11-24', '25:00', 'Willimantic, CT')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(failing(withRows(row('', '2021-11-24', '12:59', 'Willimantic, CT')))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('leads with the newest staged row until a delivery, and keeps a row without a time as its day', () => {
    // Synthetic: the sample before its delivery, with a pickup row without a time and a wording the map lacks.
    const result = parseRossTrace(withRows(row('Out For Delivery', '2021-11-24', '08:27', 'Ross Auburn, MA')
      + row('Freight Inspected', '2021-11-23', '15:10', 'In Transit') + row('Picked Up', '2021-11-19', '  :  ', 'Etobicoke, ON'), MOVING), PRO);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update_local: '2021-11-24T08:27:00' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2021-11-24T08:27:00', 'Auburn, MA', 'out_for_delivery'],
      ['2021-11-23T15:10:00', undefined, undefined],
      ['2021-11-19', 'Etobicoke, ON', 'accepted'],
    ]);
    // Oldest first is turned round, and a repeated row is kept once.
    const reversed = parseRossTrace(withRows(row('Loaded On Trailer', '2021-11-24', '08:27', 'Ross Auburn, MA')
      + row('Out For Delivery', '2021-11-24', '09:00', 'Ross Auburn, MA') + row('Out For Delivery', '2021-11-24', '09:00', 'Ross Auburn, MA'), MOVING), PRO);
    expect(reversed.events!.map((event) => event.description)).toEqual(['Out For Delivery', 'Loaded On Trailer']);
  });

  it('reads a listed shipment without rows only from its lifecycle', async () => {
    expect(parseRossTrace(withRows(''), PRO)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', summary_only: true, events: [] });
    await expect(failing(withRows('', MOVING))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('sends a lookup that fails to connect once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(xml(DELIVERED));
    await expect(carrier(fetcher).track({ number: PRO })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ross-express', description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
