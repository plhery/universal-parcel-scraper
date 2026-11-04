import assert from 'node:assert/strict';
import test from 'node:test';
import { carrierDown, main, nextState, parseFailures, plan, readState, renderBody, sections } from './canary-issue.mjs';

const runUrl = 'https://github.com/example/carriers/actions/runs/100';
const link = check => `UI tracking links (rendered public pages) > ${check} opens a tracking page`;
const changed = 'AssertionError: Expected a rendered tracker on its known route, not a homepage/error/challenge; landed on https://example.com/track with HTTP 200, titled "Track": expected \'broken\' to be \'tracking-page\'';
const timeout = 'TimeoutError: page.goto: Timeout 20000ms exceeded. Call log: - navigating to "https://example.com/track?id=1", waiting until "commit"';
const lines = failures => failures.map(([check, reason]) => `- \`${check}\`: ${reason}`).join('\n');
const needsWith = (jobs = {}) => ({
  gate: { result: 'success' }, probe: { result: 'skipped' }, adapters: { result: 'success' },
  'tracking-links': { result: 'success' }, 'search-pages': { result: 'skipped' }, ...jobs,
});
const linksFailing = (...failures) => needsWith({ 'tracking-links': { result: 'failure', outputs: { failures: lines(failures) } } });
const empty = { checks: {}, notified: [] };

test('tells a carrier that does not answer from a check that changed', () => {
  for (const reason of [
    timeout,
    'AssertionError: Expected a rendered tracker on its known route, not a homepage/error/challenge; landed on https://nrg-tk.pro/client/tracking/#1 with HTTP 503, titled "Unavailable": expected \'broken\' to be \'tracking-page\'',
    'Error: page.goto: net::ERR_CERT_DATE_INVALID at https://example.com/tracking/ Call log: - navigating to "https://example.com/tracking/"',
    'Error: page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/',
    'TypeError', 'TimeoutError', 'HTTP 503',
    'AssertionError: expected UpstreamNetworkError: Asendia UK tracker … { …(6) } to match object { name: \'NotFoundError\', …(1) }',
    'AssertionError: promise rejected "UpstreamHttpError: Example tracking return… { …(7) }" instead of resolving · caused by UpstreamHttpError: Example tracking returned HTTP 502',
  ]) assert.equal(carrierDown(reason), true, reason);
  for (const reason of [
    changed, 'HTTP 404',
    'AssertionError: Expected a rendered tracker on its known route, not a homepage/error/challenge; landed on https://example.com/x with HTTP 404, titled "Not found": expected \'broken\' to be \'tracking-page\'',
    'AssertionError: promise rejected "UpstreamHttpError: Hermes tracking return… { …(7) }" instead of resolving · caused by UpstreamHttpError: Hermes tracking returned HTTP 400',
    'AssertionError: expected ChallengeError: lbc-express requires a br… { …(5) } to match object { kind: \'indeterminate\' }',
  ]) assert.equal(carrierDown(reason), false, reason);
});

test('reads the failure lines a canary job reports', () => {
  assert.deepEqual(parseFailures('#### Heading\n\n- `A > b`: Error: x: y\nnoise\n- `c (host)`: TypeError'),
    [{ check: 'A > b', reason: 'Error: x: y' }, { check: 'c (host)', reason: 'TypeError' }]);
  assert.deepEqual(parseFailures(undefined), []);
});

test('counts the days a check keeps failing and forgets it once it passes', () => {
  const first = nextState(empty, linksFailing([link('seur'), changed], [link('jcex'), timeout]), '2026-11-04');
  assert.deepEqual(first.checks['tracking-links'][link('seur')], { reason: changed, down: false, since: '2026-11-04', last: '2026-11-04', days: 1 });
  assert.equal(first.checks['tracking-links'][link('jcex')].down, true);
  // A second run on the same day is no second day.
  const rerun = nextState(first, linksFailing([link('seur'), changed]), '2026-11-04');
  assert.equal(rerun.checks['tracking-links'][link('seur')].days, 1);
  assert.equal(rerun.checks['tracking-links'][link('jcex')], undefined);
  const next = nextState(rerun, linksFailing([link('seur'), changed]), '2026-11-05');
  assert.deepEqual(next.checks['tracking-links'][link('seur')], { reason: changed, down: false, since: '2026-11-04', last: '2026-11-05', days: 2 });
  assert.deepEqual(nextState(next, needsWith(), '2026-11-06').checks, {});
});

test('keeps the record of a job that said nothing about its checks', () => {
  const weekly = nextState(empty, needsWith({ probe: { result: 'failure', outputs: { failures: lines([['afghan-post (example.af)', 'TypeError']]) } } }), '2026-11-02');
  // The weekly probe is skipped on other days.
  assert.deepEqual(nextState(weekly, needsWith(), '2026-11-03').checks, weekly.checks);
  const timedOut = nextState(weekly, needsWith({ probe: { result: 'cancelled' } }), '2026-11-09', new Set(['probe']));
  assert.deepEqual(timedOut.checks.probe['afghan-post (example.af)'], weekly.checks.probe['afghan-post (example.af)']);
  assert.match(timedOut.checks.probe['The job'].reason, /Ran out of time/);
  const broken = nextState(timedOut, needsWith({ probe: { result: 'failure' } }), '2026-11-16');
  assert.match(broken.checks.probe['The job'].reason, /Failed before reporting/);
  assert.equal(broken.checks.probe['The job'].days, 2);
  const passed = nextState(broken, needsWith({ probe: { result: 'success' } }), '2026-11-23');
  assert.equal(passed.checks.probe, undefined);
  const flood = Array.from({ length: 81 }, (_, index) => [link(`carrier-${index}`), timeout]);
  const network = nextState(weekly, linksFailing(...flood), '2026-11-04');
  assert.deepEqual(Object.keys(network.checks['tracking-links']), ['The job']);
});

test('asks for a look at a check failing two days running, and at a carrier down for two weeks', () => {
  const state = { notified: [], checks: { 'tracking-links': {
    [link('seur')]: { reason: changed, down: false, since: '2026-11-03', last: '2026-11-04', days: 2 },
    [link('spx-br')]: { reason: changed, down: false, since: '2026-11-04', last: '2026-11-04', days: 1 },
    [link('jcex')]: { reason: timeout, down: true, since: '2026-10-30', last: '2026-11-04', days: 6 },
    [link('algerie-poste')]: { reason: timeout, down: true, since: '2026-10-21', last: '2026-11-04', days: 15 },
  } } };
  const groups = sections(state, '2026-11-04');
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([group, items]) => [group, items.map(item => item.check)])), {
    look: [link('seur')], longDown: [link('algerie-poste')], down: [link('jcex')], once: [link('spx-br')],
  });
  const body = renderBody(state, '2026-11-04', runUrl);
  assert.match(body, /^### Needs a look\n/);
  assert.match(body, /### Carrier down for two weeks\n[\s\S]*algerie-poste opens a tracking page`: TimeoutError[^\n]*\(failing since 2026-10-21, on 15 days\)/);
  assert.match(body, /<details><summary>Carrier down \(1\)<\/summary>/);
  assert.match(body, /<details><summary>Failed once \(1\)<\/summary>[\s\S]*spx-br[^\n]*\(failed 2026-11-04\)/);
  assert.ok(body.indexOf('#### Rendered UI tracking links') > 0);
});

test('keeps the record in the body, whatever the reasons hold', () => {
  const state = { notified: ['tracking-links\nx'], checks: { adapters: { 'A > b': { reason: 'expected a --> b <!-- c', down: false, since: '2026-11-01', last: '2026-11-02', days: 2 } } } };
  const body = renderBody(state, '2026-11-02', runUrl);
  assert.equal(body.match(/<!--/g).length, 1);
  assert.match(body, /expected a --> b &lt;!-- c/);
  assert.deepEqual(readState(body), state);
  assert.deepEqual(readState('An older body without a record'), empty);
});

test('closes the issue when nothing needs a look, keeping the record', () => {
  const issue = { number: '12', state: 'OPEN', body: 'An older body' };
  const actions = plan({ issue, needs: linksFailing([link('spx-br'), changed]), today: '2026-11-05', runUrl });
  assert.deepEqual(actions.map(action => action.type), ['edit', 'close']);
  assert.match(actions[0].body, /^Nothing needs a look\./);
  assert.equal(readState(actions[0].body).checks['tracking-links'][link('spx-br')].days, 1);
});

test('comments when a check starts needing a look, once', () => {
  const day1 = plan({ issue: { number: '12', state: 'CLOSED', body: '' }, needs: linksFailing([link('seur'), changed], [link('spx-br'), changed]), today: '2026-11-04', runUrl });
  assert.deepEqual(day1.map(action => action.type), ['edit']);
  const day2 = plan({ issue: { number: '12', state: 'CLOSED', body: day1[0].body }, needs: linksFailing([link('seur'), changed]), today: '2026-11-05', runUrl });
  assert.deepEqual(day2.map(action => action.type), ['edit', 'reopen', 'comment']);
  assert.match(day2[2].body, /^### Needs a look\n[\s\S]*seur opens a tracking page/);
  assert.doesNotMatch(day2[2].body, /spx-br/);
  assert.ok(day2[2].body.endsWith(`Run: ${runUrl}`));
  const day3 = plan({ issue: { number: '12', state: 'OPEN', body: day2[0].body }, needs: linksFailing([link('seur'), changed], [link('ocs'), changed]), today: '2026-11-06', runUrl });
  assert.deepEqual(day3.map(action => action.type), ['edit']);
  const day4 = plan({ issue: { number: '12', state: 'OPEN', body: day3[0].body }, needs: linksFailing([link('seur'), changed], [link('ocs'), changed]), today: '2026-11-07', runUrl });
  assert.deepEqual(day4.map(action => action.type), ['edit', 'comment']);
  assert.match(day4[1].body, /ocs opens/);
  assert.doesNotMatch(day4[1].body, /seur opens/);
});

test('waits two weeks before asking about a carrier that does not answer', () => {
  let body = '';
  const types = [];
  for (let day = 1; day <= 15; day++) {
    const today = `2026-11-${String(day).padStart(2, '0')}`;
    const actions = plan({ issue: { number: '12', state: types.at(-1)?.includes('reopen') ? 'OPEN' : 'CLOSED', body }, needs: linksFailing([link('jcex'), timeout]), today, runUrl });
    body = actions[0].body;
    types.push(actions.map(action => action.type).join(','));
  }
  assert.deepEqual(types.slice(0, 14), Array(14).fill('edit'));
  assert.equal(types[14], 'edit,reopen,comment');
  assert.match(body, /### Carrier down for two weeks/);
});

test('creates the issue to hold the record, closed while nothing needs a look', () => {
  assert.deepEqual(plan({ issue: null, needs: needsWith(), today: '2026-11-04', runUrl }), []);
  assert.deepEqual(plan({ issue: null, needs: linksFailing([link('spx-br'), changed]), today: '2026-11-04', runUrl }).map(action => action.type), ['create', 'close']);
});

function fakeGh({ issues, jobs = '', annotations = '' }) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'api' && args[1].endsWith('/jobs')) return jobs;
    if (args[0] === 'api' && args[1].includes('/check-runs/')) return annotations;
    if (args[0] === 'api') return JSON.stringify(issues);
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/example/carriers/issues/13\n';
    return '';
  };
  return { gh, calls, writes: () => calls.filter(call => call.args[0] === 'issue').map(call => call.args.slice(1, 3)) };
}

const env = needs => ({ GH_REPO: 'example/carriers', RUN_ID: '100', RUN_URL: runUrl, NEEDS: JSON.stringify(needs) });

test('writes to the open issue before a closed one', () => {
  const issues = [
    { number: 14, title: 'Something else', state: 'open', body: '' },
    { number: 12, title: 'Daily carrier canary failures', state: 'open', body: '' },
    { number: 6, title: 'Daily carrier canary failures', state: 'closed', body: '' },
  ];
  const { gh, writes, calls } = fakeGh({ issues });
  main({ env: env(linksFailing([link('spx-br'), changed])), gh, today: '2026-11-04' });
  assert.deepEqual(writes(), [['edit', '12'], ['close', '12']]);
  assert.match(calls.find(call => call.args[1] === 'edit').input, /spx-br/);
});

test('leaves the issue alone after a superseded run, and reads a job that ran out of time', () => {
  const issues = [{ number: 12, title: 'Daily carrier canary failures', state: 'open', body: '' }];
  const needs = needsWith({ 'search-pages': { result: 'cancelled' } });
  const jobs = '1 success Rendered UI tracking links\n2 cancelled Carrier search pages at phone size\n';
  const superseded = fakeGh({ issues, jobs, annotations: 'The operation was canceled.' });
  assert.deepEqual(main({ env: env(needs), gh: superseded.gh, today: '2026-11-04' }), []);
  assert.deepEqual(superseded.writes(), []);
  const late = fakeGh({ issues, jobs, annotations: 'The job running on runner X has exceeded the maximum execution time of 40 minutes.' });
  main({ env: env(needs), gh: late.gh, today: '2026-11-04' });
  assert.match(late.calls.find(call => call.args[1] === 'edit').input, /Ran out of time/);
});

test('creates the first issue and closes it by the number it was given', () => {
  const { gh, writes } = fakeGh({ issues: [] });
  main({ env: env(linksFailing([link('spx-br'), changed])), gh, today: '2026-11-04' });
  assert.deepEqual(writes(), [['create', '--title'], ['close', '13']]);
});
