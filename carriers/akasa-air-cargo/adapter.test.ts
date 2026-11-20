import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { formFields, normalizeAirWaybill, parseTracking, tracker } from './parser.js';

const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const departed = readFileSync(new URL('./fixtures/departed.html', import.meta.url), 'utf8');
const form = `<form id="FrmAWBTracking" method="post" action="./FrmAWBTracking.aspx">
  <input type="hidden" name="__VIEWSTATE" value="guest-state" />
  <input type="hidden" name="__EVENTVALIDATION" value="validation" />
  <input id="txtPrefix" name="txtPrefix" /><textarea id="TextBoxAWBno" name="TextBoxAWBno"></textarea>
  <input id="ButtonGO" name="ButtonGO" type="submit" value="Track" />
</form>`;

it('binds the entire published waybill and reads the delivered history in station wall time', () => {
  const result = parseTracking(delivered, '51650024855');
  expect(result).toMatchObject({
    current_stage: 'delivered',
    last_status_text: 'Delivered at RUH',
    last_update: null,
    last_update_local: '2026-01-24T03:28:27',
    weight_kg: 1452,
  });
  expect(result.events?.map(event => [event.description, event.stage, event.location])).toEqual([
    ['Delivered', 'delivered', 'RUH'],
    ['Arrived', 'in_transit', 'RUH'],
    ['Departed', 'in_transit', 'BOM'],
    ['Manifested', undefined, 'BOM'],
    ['Accepted', 'accepted', 'BOM'],
    ['Booked', 'registered', 'BOM'],
  ]);
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('reads a departure and rejects a history that belongs to a different airway bill', () => {
  expect(parseTracking(departed, '51650000226')).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Departed at BOM',
  });
  expect(() => parseTracking(delivered, '51650000226')).toThrow(IndeterminateError);
});

it('distinguishes the bound missing message, a verification response and an unrelated page', () => {
  const missing = `<span id="LabelStatus">AWB Details not available</span>
    <input id="txtPrefix" value="516"><textarea id="TextBoxAWBno">50024855</textarea>`;
  expect(() => parseTracking(missing, '51650024855')).toThrow(NotFoundError);
  expect(() => parseTracking(missing, '51650000226')).toThrow(SchemaError);
  expect(() => parseTracking('<title>Just a moment</title>', '51650024855')).toThrow(ChallengeError);
  expect(() => parseTracking('<title>Akasa</title>', '51650024855')).toThrow(SchemaError);
});

it('validates the waybill and returns same-origin form state only', () => {
  expect(normalizeAirWaybill(' 516-50024855 ')).toBe('51650024855');
  expect(() => normalizeAirWaybill('516-50024856')).toThrow(InvalidInputError);
  expect(() => normalizeAirWaybill('485-50024855')).toThrow(InvalidInputError);
  expect(() => formFields(form.replace('./FrmAWBTracking.aspx', 'https://example.test/'), '51650024855'))
    .toThrow(SchemaError);
});

it('gets a fresh form and posts it with the full waybill through the caller transport', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(form))
    .mockResolvedValueOnce(new Response(delivered));
  const instance = adapter({ fetcher, userAgent: 'Akasa test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: '516-50024855' })).resolves.toMatchObject({ current_stage: 'delivered' });
  expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    [tracker, 'GET'], [tracker, 'POST'],
  ]);
  const init = fetcher.mock.calls[1]![1];
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Akasa test agent');
  expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
    __VIEWSTATE: 'guest-state', __EVENTVALIDATION: 'validation',
    txtPrefix: '516', TextBoxAWBno: '50024855', ButtonGO: 'Track',
  });
});
