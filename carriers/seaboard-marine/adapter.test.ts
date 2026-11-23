import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { containerCheckDigit, SEABOARD_TRACKER, seaboardMoveOf, seaboardQuery, seaboardResult, seaboardSearchUrl } from './parser.js';
import { seaboardMove, seaboardStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples. The unknown containers are invented, with matching check digits: the
// tracker holds no record of one, and a record without information of the other.
const ON_BOARD = 'SMLU3130772';
const LIMON = 'SMLU3148560';
const MIAMI = 'SMLU8522821';
const CUSTOMER = 'SMLU7704689';
const UNKNOWN = 'SMLU9999980';
const NO_INFORMATION = 'SMLU1234567';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const found = (number: string) => fixture(`found-${number}.html`);
const read = (body: string, number: string) => seaboardResult(seaboardMoveOf(body, seaboardQuery(number)));
const failure = (body: string, number: string) => {
  try {
    read(body, number);
  } catch (error) {
    return error;
  }
  throw new Error('The reply was read');
};

describe('Seaboard Marine replies', () => {
  it('reads the container\'s last move as a wall clock, its history truncated', () => {
    expect(read(found(ON_BOARD), ON_BOARD)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Equipment On-Board Seaboard Viking V. 22 Full.', last_update: null, last_update_local: '2026-11-18T19:04:00',
      expected_delivery: null, history_truncated: true,
      events: [{ local_time: '2026-11-18T19:04:00', description: 'Equipment On-Board Seaboard Viking V. 22 Full.', stage: 'in_transit', stage_source: 'carrier_map' }],
    });
  });

  it('reads the place a move at a place names', () => {
    expect(read(found(MIAMI), MIAMI).events).toEqual([{
      local_time: '2026-11-20T19:43:00', location: 'Port Of Miami', description: 'Equipment At Port Of Miami Moving Export Full.',
      stage: 'in_transit', stage_source: 'carrier_map',
    }]);
  });

  it('leaves a move the wording does not settle without a stage', () => {
    const empty = read(found(LIMON), LIMON);
    expect(empty).toMatchObject({ status: 'unknown', last_status_text: 'Equipment At Puerto Limon, Costa Rica Moving Import Empty.', last_update_local: '2026-10-02T09:47:00' });
    expect(empty).not.toHaveProperty('current_stage');
    expect(empty.events).toEqual([{ local_time: '2026-10-02T09:47:00', location: 'Puerto Limon, Costa Rica', description: 'Equipment At Puerto Limon, Costa Rica Moving Import Empty.' }]);
    expect(read(found(CUSTOMER), CUSTOMER).events).toEqual([{ local_time: '2026-11-19T17:19:00', description: 'Equipment Dispatched To Customer Moving No Direction Empty.' }]);
    const unknown = read(found(ON_BOARD).replace('Equipment On-Board Seaboard Viking V. 22 Full.', 'Equipment Under Repair.'), ON_BOARD);
    expect(unknown).toMatchObject({ status: 'unknown', events: [{ local_time: '2026-11-18T19:04:00', description: 'Equipment Under Repair.' }] });
  });

  it('reads the card\'s notice as a container Seaboard Marine does not track, and a card of dashes as its empty answer', () => {
    expect(failure(fixture(`notfound-${NO_INFORMATION}.html`), NO_INFORMATION)).toMatchObject({ kind: 'not_found' });
    expect(failure(fixture(`unknown-${UNKNOWN}.html`), UNKNOWN)).toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The notice reads alike for a record whose own check digit differs.
    const otherCheck = fixture(`notfound-${NO_INFORMATION}.html`).replace('SMLU 123456 7', 'SMLU 123456 1').replace(/(EquipmentCheck:<\/div><div\s+class='[^']*'>)7/, '$11');
    expect(failure(otherCheck, NO_INFORMATION)).toMatchObject({ kind: 'not_found' });
  });

  it('reads another container, another search, a changed card or an invalid move as a changed reply, never as missing', () => {
    const page = found(ON_BOARD);
    const fails = (body: string, number = ON_BOARD) => expect(failure(body, number), body.slice(-400)).toMatchObject({ kind: 'schema' });
    fails(page, LIMON);
    fails(page.replace('value="SMLU 313077"', 'value="SMLU 314856"'));
    fails(page.replace('value="SMLU 313077"', 'value'));
    fails(page.replace('SMLU 313077 2', 'SMLU 313078 2'));
    fails(page.replace('SMLU 313077 2', 'SMLU 313077 4'));
    fails(page.replace(/(EquipmentCheck:<\/div><div\s+class='[^']*'>)2/, '$14'));
    fails(page.replace('SMLU 313077 2', 'SMLU3130772'));
    fails(page.replace('Last move:', 'Status:'));
    fails(page.replace(/<div\s+class=sml-row><div\s+class="[^"]*">Equipment Class:[\s\S]*?<\/div><\/div>/, ''));
    fails(page.replace('Equipment On-Board Seaboard Viking V. 22 Full.', ' '));
    fails(page.replace('Equipment On-Board Seaboard Viking V. 22 Full.', '-'));
    fails(page.replace('11/18/2026 07:04 PM', '11/31/2026 07:04 PM'));
    fails(page.replace('11/18/2026 07:04 PM', '2026-11-18 19:04'));
    fails(page.replace('11/18/2026 07:04 PM', '11/18/2026 19:04 PM'));
    fails(page.replace('11/18/2026 07:04 PM', '-'));
    fails(page.replace('printable-results', 'results'));
    fails(page.replace('action=https://www.seaboardmarine.com/tracking-results/', 'action=https://www.seaboardmarine.com/vessel-results/'));
    fails('<html><body><h1>Error 500</h1></body></html>');
    fails('');
  });

  it('reads a bot check in place of the page as a challenge', () => {
    for (const body of ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><head><title>Access Denied</title></head><body>You don\'t have permission to access this server.</body></html>',
      '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>']) {
      expect(failure(body, ON_BOARD)).toMatchObject({ kind: 'challenge' });
    }
  });
});

type Reply = { status?: number; body: string; headers?: Record<string, string> };
/** A website that answers each request with the next reply, recording what it was sent. */
function website(replies: (Reply | Error)[]) {
  const calls: { url: string; headers: Headers; redirect?: RequestRedirect }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    const reply = replies.shift();
    if (!reply) throw new Error('The test website has no reply left');
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': 'text/html; charset=UTF-8', ...reply.headers } });
  });
  return { fetcher, calls };
}
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), userAgent: 'example-agent/1.0', env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);

describe('Seaboard Marine adapter', () => {
  it('takes a container with its check digit, and asks the search for its owner code and serial', async () => {
    expect([containerCheckDigit('SMLU313077'), containerCheckDigit('SMLU852282')]).toEqual([2, 1]);
    expect(seaboardQuery(' smlu 313077-2 ')).toEqual({ number: ON_BOARD, search: 'SMLU 313077' });
    expect(seaboardSearchUrl(seaboardQuery(ON_BOARD))).toBe(`${SEABOARD_TRACKER}?eq_number=SMLU+313077&vin_number=`);
    const { fetcher } = website([]);
    for (const number of ['SMLU3130773', 'SMLU313077', 'SMLA3130772', '3130772', 'SEABOARD', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: ON_BOARD }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('opens the search\'s page for the container and reads its card', async () => {
    const { fetcher, calls } = website([{ body: found(MIAMI) }]);
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: MIAMI.toLowerCase() })).resolves.toEqual(read(found(MIAMI), MIAMI));
    expect(calls).toEqual([{ url: `${SEABOARD_TRACKER}?eq_number=SMLU+852282&vin_number=`, headers: expect.any(Headers), redirect: 'manual' }]);
    expect(calls[0]!.headers.get('user-agent')).toBe('example-agent/1.0');
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('reads the empty answers and the website\'s refusals and failures by their kind', async () => {
    await expect(carrier(website([{ body: fixture(`notfound-${NO_INFORMATION}.html`) }]).fetcher).track({ number: NO_INFORMATION })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(website([{ body: fixture(`unknown-${UNKNOWN}.html`) }]).fetcher).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'], [404, 'transport'], [302, 'transport']] as const) {
      await expect(carrier(website([{ status, body: '', headers: status === 302 ? { location: '/' } : {} }]).fetcher).track({ number: ON_BOARD }), String(status))
        .rejects.toMatchObject({ kind });
    }
    await expect(carrier(website([{ body: 'x'.repeat(2_600_000) }]).fetcher).track({ number: ON_BOARD })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
  });

  it('asks once more when a request does not reach the website', async () => {
    const { fetcher } = website([new TypeError('fetch failed'), { body: found(ON_BOARD) }]);
    await expect(carrier(fetcher).track({ number: ON_BOARD })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked when the number is filed under Seaboard Marine, which dates a place\'s wall clock on its zone', async () => {
    const { fetcher } = website([{ body: found(LIMON) }]);
    const answer = await createTracker({ providers: [], env: {}, fetcher }).track({ number: LIMON, carrier: 'seaboard-marine' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'seaboard-marine', source: 'seaboard-marine', result: { history_truncated: true } });
    expect(answer.result.events[0]).toMatchObject({ local_time: '2026-10-02T09:47:00', time: '2026-10-02T09:47:00-06:00', time_zone: 'America/Costa_Rica', time_zone_basis: 'place' });
    expect(carrierDefinition('seaboard-marine').tracking).toMatchObject({ adapter: 'seaboard-marine', localClocks: true });
  });
});

describe('Seaboard Marine status vocabulary', () => {
  it('stages each wording the page gives, whatever the place, vessel or voyage', () => {
    for (const entry of statuses.entries) {
      expect(seaboardStage(entry.wording) ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'seaboard-marine', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(seaboardMove('Equipment At Manzanillo, Panama Moving Import Full.')).toEqual({ place: 'Manzanillo, Panama', stage: 'in_transit' });
    expect(seaboardMove('Equipment At Kingston, Jamaica Moving No Direction Full.')).toEqual({ place: 'Kingston, Jamaica' });
    expect(seaboardMove('Equipment Dispatched To Customer Moving Import Full.')).toEqual({});
    expect(seaboardMove('Equipment On-Board Seaboard Blue V. 117N Full.')).toEqual({ stage: 'in_transit' });
    expect(seaboardMove('Equipment On-Board Seaboard Blue V. 117N Empty.')).toEqual({});
    expect(seaboardMove('Equipment Under Repair.')).toBeUndefined();
    expect(statusMap.stage(null, 'equipment at port of miami moving import full.')).toBe('in_transit');
    expect(statusMap.stage(null, 'moving import full')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'seaboard-marine', providerCode: null, description: 'Equipment Under Repair.' })).toEqual({ kind: 'unknown' });
  });
});
