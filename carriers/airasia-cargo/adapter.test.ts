import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const departed = fixture('departed');
const notFound = fixture('not-found');
const reference = '97521467692';

it('reads booking and flight milestones in station wall time', () => {
  const result = parseTracking(departed, reference);
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed at DPS', weight_kg: 212,
    last_update: null, last_update_local: '2023-08-11T11:20:00',
  });
  expect(result.events?.map(event => [event.description, event.location, event.local_time, event.stage])).toEqual([
    ['Departed', 'DPS', '2023-08-11T11:20:00', 'in_transit'],
    ['Manifested', 'DPS', '2023-08-11T11:20:00', undefined],
    ['Accepted', 'DPS', '2023-08-11T06:08:00', 'accepted'],
    ['Booked', 'DPS', '2023-08-10T06:38:00', 'registered'],
  ]);
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('binds the not-found answer, another waybill, a verification page and changed columns', () => {
  expect(() => parseTracking(notFound, '80748271635')).toThrow(NotFoundError);
  expect(() => parseTracking(notFound, reference)).toThrow(SchemaError);
  expect(() => parseTracking(departed, '97521467703')).toThrow(IndeterminateError);
  expect(() => parseTracking('<title>Just a moment...</title>', reference)).toThrow(ChallengeError);
  expect(() => parseTracking(departed.replace('<th scope="col">Flight Date</th>', '<th scope="col">Flight</th>'), reference))
    .toThrow(SchemaError);
  expect(() => parseTracking(departed.replace('<td>11/08/2023 06:08</td>', '<td>&nbsp;</td>'), reference)).toThrow(SchemaError);
});

it('opens the tracking link for each AirAsia prefix and validates the waybill first', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(departed))
    .mockResolvedValueOnce(new Response(notFound));
  const instance = adapter({ fetcher, userAgent: 'AirAsia test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: '975-21467693' })).rejects.toThrow(InvalidInputError);
  await expect(instance.track({ number: '843-21467692' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(instance.track({ number: ' 975-21467692 ' })).resolves.toMatchObject({ current_stage: 'in_transit' });
  await expect(instance.track({ number: '807 48271635' })).rejects.toThrow(NotFoundError);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    'https://airasia.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=975&AWBNo=21467692',
    'https://airasia.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=807&AWBNo=48271635',
  ]);
  const init = fetcher.mock.calls[0]![1];
  expect(new Headers(init?.headers).get('User-Agent')).toBe('AirAsia test agent');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});
