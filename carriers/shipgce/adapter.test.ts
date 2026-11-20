import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const found = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');
const number = numbers.records[0]!.number.toUpperCase();

it('reads the matching waybill and keeps both carriers’ scans as local clocks', () => {
  const result = parseTracking(found, number);
  expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2019-04-29T09:37:00' });
  expect(result.events).toHaveLength(15);
  expect(result.events?.[0]).toMatchObject({ stage: 'delivered', local_time: '2019-04-29T09:37:00' });
  expect(result.events?.at(-1)).toMatchObject({ stage: 'registered' });
});

it('distinguishes a missing waybill, another waybill and a changed or blocked page', () => {
  expect(() => parseTracking(missing, 'GC000000000US')).toThrow(NotFoundError);
  expect(() => parseTracking(found, 'GC000000000US')).toThrow(IndeterminateError);
  expect(() => parseTracking('<title>Just a moment</title>', number)).toThrow(ChallengeError);
  expect(() => parseTracking('<title>Track & Trace</title>', number)).toThrow(SchemaError);
});
