import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The carrier canary's issue. Hundreds of live checks against carriers' own
// sites never all pass on the same day, so the issue does not track every
// failure: it keeps a record of each failing check in its body, and asks for
// attention only for a check that keeps failing on a page that answers, or for
// a carrier that has not answered for two weeks. A carrier that is down needs
// no change here until then; a check that failed once is listed and left.
// Runs in the report job with no dependencies installed.

/** Canary jobs, by their key in the workflow, with their names. */
export const JOBS = {
  probe: 'Public carrier reachability',
  adapters: 'Carrier adapters with synthetic numbers',
  'tracking-links': 'Rendered UI tracking links',
  'search-pages': 'Carrier search pages at phone size',
};
export const TITLE = 'Daily carrier canary failures';
/** A carrier down this many days is asked about: keep checking it or not. */
export const LONG_DOWN_DAYS = 14;
// More failures than this in one job is the runner's network, not the carriers.
const MASS_FAILURE = 80;
// GitHub refuses an issue body over 65,536 characters.
const BODY_LIMIT = 65_000;
const STATE = /<!-- canary-state\n([\s\S]*?)\n-->/;
// The carrier's site gave no answer, or a server error: timeouts, refused,
// reset or unresolved connections, certificate failures and 5xx statuses.
const DOWN = [
  /\bTimeoutError\b|\bTimeout \d+ms exceeded\b|\btimed out\b/i,
  /net::ERR_(?:CONNECTION|NAME|ADDRESS|TIMED_OUT|EMPTY_RESPONSE|SSL|CERT|HTTP2|QUIC|NETWORK|SOCKET|TUNNEL)/,
  /\bwith HTTP 5\d\d\b|\breturned HTTP 5\d\d\b|^HTTP 5\d\d$/,
  /\bUpstreamNetworkError\b|\bBudgetExceededError\b/,
  // The reachability probe names only the error of a request that got no answer.
  /^[A-Za-z]*Error$/,
];

export function carrierDown(reason) {
  return DOWN.some(pattern => pattern.test(reason));
}

/** The `- \`check\`: reason` lines a canary job reports as its `failures` output. */
export function parseFailures(text) {
  const failures = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^- `([^`]+)`: (.*)$/.exec(line);
    if (match) failures.push({ check: match[1], reason: match[2] });
  }
  return failures;
}

export function readState(body) {
  const match = STATE.exec(body ?? '');
  if (!match) return { checks: {}, notified: [] };
  try {
    const state = JSON.parse(match[1]);
    return { checks: state.checks ?? {}, notified: state.notified ?? [] };
  } catch {
    return { checks: {}, notified: [] };
  }
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function failing(previous, reason, today) {
  const days = !previous ? 1 : previous.last === today ? previous.days : previous.days + 1;
  return { reason, down: carrierDown(reason), since: previous?.since ?? today, last: today, days };
}

/**
 * Merges a run into the record. A job that reported replaces its checks: those
 * it no longer lists passed. A job that was skipped, ran out of time or failed
 * before reporting keeps its record, since it says nothing about them; the
 * last two become a failure of the job itself. `timedOut` holds the keys of
 * jobs that ran out of time.
 */
export function nextState(previous, needs, today, timedOut = new Set()) {
  const checks = {};
  for (const job of Object.keys(JOBS)) {
    const recorded = previous.checks[job] ?? {};
    const { result, outputs } = needs[job] ?? {};
    const failures = parseFailures(outputs?.failures);
    let jobFailure;
    if (result === 'cancelled' && timedOut.has(job)) jobFailure = 'Ran out of time before reporting checks; see the run log.';
    else if (result === 'failure' && !failures.length) jobFailure = 'Failed before reporting checks; see the run log.';
    else if (failures.length > MASS_FAILURE) jobFailure = `${failures.length} checks failed at once, which points at the runner's network; see the run log.`;
    if (jobFailure || !['success', 'failure'].includes(result)) {
      checks[job] = { ...recorded };
      delete checks[job]['The job'];
      if (jobFailure) checks[job]['The job'] = failing(recorded['The job'], jobFailure, today);
    } else {
      checks[job] = Object.fromEntries(failures.map(({ check, reason }) => [check, failing(recorded[check], reason, today)]));
    }
    if (!Object.keys(checks[job]).length) delete checks[job];
  }
  return { checks, notified: previous.notified };
}

/** What each recorded failure is, as of today. */
export function sections(state, today) {
  const groups = { look: [], longDown: [], down: [], once: [] };
  for (const [job, checks] of Object.entries(state.checks)) {
    for (const [check, entry] of Object.entries(checks)) {
      const item = { key: `${job}\n${check}`, job, check, ...entry };
      if (entry.down) groups[entry.days >= 2 && daysBetween(entry.since, today) >= LONG_DOWN_DAYS ? 'longDown' : 'down'].push(item);
      else groups[entry.days >= 2 ? 'look' : 'once'].push(item);
    }
  }
  for (const group of Object.values(groups)) group.sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  return groups;
}

const HEADINGS = {
  look: ['Needs a look', 'Failed in two runs in a row, on different days, on a page or service that answers: the carrier changed something, or the code did.'],
  longDown: ['Carrier down for two weeks', `No answer, or server errors, for ${LONG_DOWN_DAYS} days or more: decide whether to keep checking it.`],
  down: ['Carrier down', 'No answer, or server errors, for less than two weeks so far.'],
  once: ['Failed once', 'Failed on one day only so far.'],
};

function list(items, withReasons = true) {
  const lines = [];
  for (const job of Object.keys(JOBS)) {
    const own = items.filter(item => item.job === job);
    if (!own.length) continue;
    lines.push(`#### ${JOBS[job]}`, '');
    for (const item of own) {
      const record = item.days > 1 ? `failing since ${item.since}, on ${item.days} days` : `failed ${item.last}`;
      // A `<` in a page's title or an error could open an HTML comment that hides the rest.
      lines.push(`- \`${item.check}\`${withReasons ? `: ${item.reason.replace(/</g, '&lt;')}` : ''} (${record})`);
    }
    lines.push('');
  }
  return lines;
}

function section(group, items, { collapsed = false, withReasons = true } = {}) {
  if (!items.length) return [];
  const [heading, meaning] = HEADINGS[group];
  if (!collapsed) return [`### ${heading}`, '', meaning, '', ...list(items, withReasons)];
  return [`<details><summary>${heading} (${items.length})</summary>`, '', meaning, '', ...list(items, withReasons), '</details>', ''];
}

function serialize(state) {
  // Angle brackets are escaped so that no check or reason can end the comment or open another.
  return `<!-- canary-state\n${JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}\n-->`;
}

export function renderBody(state, today, runUrl) {
  const groups = sections(state, today);
  const head = groups.look.length || groups.longDown.length ? [] : ['Nothing needs a look.', ''];
  const render = (withReasons) => [...head,
    ...section('look', groups.look), ...section('longDown', groups.longDown),
    ...section('down', groups.down, { collapsed: true, withReasons }), ...section('once', groups.once, { collapsed: true, withReasons }),
    `Run: ${runUrl}`, '', serialize(state)].join('\n');
  const body = render(true);
  // A runner-wide bad day can list too much: the record matters more than the reasons.
  return body.length <= BODY_LIMIT ? body : render(false);
}

/** The issue writes for this run, given the canary issue as it stands, if any. */
export function plan({ issue, needs, today, runUrl, timedOut }) {
  const previous = readState(issue?.body);
  const state = nextState(previous, needs, today, timedOut);
  const groups = sections(state, today);
  const actionable = [...groups.look, ...groups.longDown];
  const known = new Set(previous.notified);
  const fresh = actionable.filter(item => !known.has(item.key));
  state.notified = actionable.map(item => item.key);
  const body = renderBody(state, today, runUrl);
  const notice = [...section('look', fresh.filter(item => !item.down)), ...section('longDown', fresh.filter(item => item.down)), `Run: ${runUrl}`].join('\n');
  const actions = [];
  if (!issue) {
    // The record has to live somewhere, even when nothing needs a look yet.
    if (!Object.keys(state.checks).length) return actions;
    actions.push({ type: 'create', body });
    if (!actionable.length) actions.push({ type: 'close', comment: `Nothing needs a look: ${runUrl}` });
    return actions;
  }
  actions.push({ type: 'edit', body });
  if (issue.state === 'OPEN' && !actionable.length) actions.push({ type: 'close', comment: `Nothing needs a look: ${runUrl}` });
  else if (issue.state !== 'OPEN' && actionable.length) actions.push({ type: 'reopen' }, { type: 'comment', body: notice });
  else if (issue.state === 'OPEN' && fresh.length) actions.push({ type: 'comment', body: notice });
  return actions;
}

function defaultGh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
}

/** Jobs that ran out of time, or null when a cancelled job was superseded instead. */
function timedOutJobs(gh, repo, runId, needs) {
  const cancelled = Object.keys(JOBS).filter(job => needs[job]?.result === 'cancelled');
  if (!cancelled.length) return new Set();
  const jobs = gh(['api', `repos/${repo}/actions/runs/${runId}/jobs`, '--paginate', '--jq', '.jobs[] | "\\(.id) \\(.conclusion) \\(.name)"'])
    .split('\n').map(line => /^(\d+) (\S+) (.+)$/.exec(line)).filter(Boolean).map(([, id, conclusion, name]) => ({ id, conclusion, name }));
  const timedOut = new Set();
  for (const job of cancelled) {
    const run = jobs.find(item => item.name === JOBS[job] && item.conclusion === 'cancelled');
    // A job that runs out of time ends cancelled, like the jobs of a
    // superseded run; only its annotation tells them apart.
    const annotations = run ? gh(['api', `repos/${repo}/check-runs/${run.id}/annotations`, '--jq', '.[].message']) : '';
    if (!/exceeded the maximum execution time/.test(annotations)) return null;
    timedOut.add(job);
  }
  return timedOut;
}

export function main({ env = process.env, gh = defaultGh, today = new Date().toISOString().slice(0, 10) } = {}) {
  const repo = env.GH_REPO;
  const needs = JSON.parse(env.NEEDS);
  const timedOut = timedOutJobs(gh, repo, env.RUN_ID, needs);
  // A superseded run says nothing about carrier health.
  if (!timedOut) return [];
  // The issues this workflow opened, an open one before any closed one. Not a
  // search: the search index once missed the open issue, and a second one was
  // opened beside it. A failed listing ends the step instead of opening another.
  const issues = JSON.parse(gh(['api', '-X', 'GET', `repos/${repo}/issues`, '-f', 'state=all', '-f', 'creator=github-actions[bot]', '-F', 'per_page=100']))
    .filter(item => item.title === TITLE && !item.pull_request);
  const found = issues.find(item => item.state === 'open') ?? issues[0];
  const issue = found ? { number: String(found.number), state: found.state.toUpperCase(), body: found.body ?? '' } : null;
  const actions = plan({ issue, needs, today, runUrl: env.RUN_URL, timedOut });
  let number = issue?.number;
  for (const action of actions) {
    if (action.type === 'create') number = gh(['issue', 'create', '--title', TITLE, '--body-file', '-'], action.body).trim().split('/').pop();
    else if (action.type === 'edit') gh(['issue', 'edit', number, '--body-file', '-'], action.body);
    else if (action.type === 'comment') gh(['issue', 'comment', number, '--body-file', '-'], action.body);
    else if (action.type === 'close') gh(['issue', 'close', number, '--comment', action.comment]);
    else if (action.type === 'reopen') gh(['issue', 'reopen', number]);
  }
  return actions;
}

const executable = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === executable) main();
