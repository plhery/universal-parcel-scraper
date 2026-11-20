import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const container = fixture('container');
const missing = fixture('missing');
const number = numbers.records[0]!.number;

it('uses the guest container search and keeps only its actual milestones', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(container));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number: `${number.slice(0, 4).toLowerCase()} ${number.slice(4)}` });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://tracking.cargolane.net/stage-api/web/ebOrder/shipmentInfo?seaOrAir=S&paramType=ctn_no&paramNo=${number}`,
    expect.anything());
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', last_status_text: 'DISCHARGE',
    last_update_local: '2026-11-13T20:44:00',
  });
  expect(result.events).toHaveLength(7);
  expect(result.events?.[1]).toMatchObject({ provider_code: 'MF_PLD_ARRIVAL', local_time: '2026-11-12T09:58:00' });
  expect(result.events?.[5]).toMatchObject({ provider_code: 'TM_TK_FCTN_IN_PORT', stage: 'accepted' });
  expect(result.events?.[6]).not.toHaveProperty('stage');
});

it('keeps empty equipment return in the history without claiming cargo delivery', () => {
  const result = parseTracking(fixture('rail'), numbers.records[1]!.number);
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'EMPTY RETURN' });
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.find(event => event.provider_code === 'DS_RAIL_POD_DEPARTURE')).toMatchObject({ stage: 'in_transit' });
});

it('distinguishes the empty lookup from an unbound history or a service error', () => {
  expect(() => parseTracking(missing, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(container, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(missing.replace('true', 'false'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
