import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import CanaryReporter, { writeCanaryReport } from './canary-report.mjs';

function githubFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-report-'));
  return { GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'), GITHUB_OUTPUT: path.join(directory, 'output') };
}

test('lists failed and inconclusive checks but counts gated ones', (t) => {
  const env = githubFiles();
  for (const [name, value] of Object.entries({ ...env, CANARY_SUMMARY_TITLE: 'Adapters' })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const testCase = (fullName, result) => ({ fullName, result: () => result });
  new CanaryReporter().onTestRunEnd([{
    relativeModuleId: 'carriers/ctt/adapter.live.test.ts',
    errors: () => [],
    children: {
      *allTests() {
        yield testCase('CTT > maps a wrong number to a 404', { state: 'passed' });
        yield testCase('PostNL > maps a wrong number to a 404', {
          state: 'failed', errors: [{ name: 'AssertionError', message: 'expected 429\n  to be | 404' }],
        });
        yield testCase('Hermes > returns a delivered order', {
          state: 'failed', errors: [{ name: 'AssertionError', message: 'promise rejected "UpstreamHttpError: Hermes tracking return… { …(7) }" instead of resolving',
            cause: { name: 'UpstreamHttpError', message: 'Hermes tracking returned HTTP 400' } }],
        });
        yield testCase('UPS > opens a tracking page', { state: 'skipped', note: 'Carrier bot protection' });
        yield testCase('FedEx > returns real history', { state: 'skipped', note: undefined });
      },
    },
  }], []);

  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /^### Adapters\n\n1 passed · 2 failed · 1 unverified · 1 not run/);
  assert.match(summary, /\| ❌ failed \| PostNL > maps a wrong number to a 404 \| `AssertionError: expected 429 to be \\\| 404` \|/);
  assert.match(summary, /\| ⚠️ unverified \| UPS > opens a tracking page \| `Carrier bot protection` \|/);
  assert.doesNotMatch(summary, /FedEx|CTT/);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    /^failures<<(EOF_[\w-]+)\n- `PostNL > maps a wrong number to a 404`: AssertionError: expected 429 to be \\\| 404\n- `Hermes > returns a delivered order`: AssertionError: promise rejected "UpstreamHttpError: Hermes tracking return… \{ …\(7\) \}" instead of resolving · caused by UpstreamHttpError: Hermes tracking returned HTTP 400\n\1\n$/);
});

test('writes nothing outside GitHub Actions and no output without failures', () => {
  assert.doesNotThrow(() => writeCanaryReport({ title: 'Probe', totals: '1/1', rows: [] }, {}));
  const env = githubFiles();
  writeCanaryReport({ title: 'Probe', totals: '1/1 reachable', rows: [] }, env);
  assert.equal(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), '### Probe\n\n1/1 reachable\n\n');
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
});

test('publishes a landing address without its query and a page title as inert text', () => {
  const env = githubFiles();
  const reason = 'Error: navigating to "https://carrier.example/r?next=SECRET-TOKEN", landed on '
    + 'https://carrier.example/track/done?session=SECRET-TOKEN&challenge=SECRET-TOKEN#SECRET-TOKEN with HTTP 200, '
    + 'titled "[Claim](https://evil.example/x) ![p](https://evil.example/p.png) @someone example/repo#12 | `x`"';
  writeCanaryReport({ title: 'Links', totals: '0 passed', rows: [{ result: 'failed', check: 'Links > seur opens a tracking page', reason }] }, env);
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  const output = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  for (const text of [summary, output]) {
    assert.doesNotMatch(text, /SECRET-TOKEN/);
    assert.match(text, /landed on https:\/\/carrier\.example\/track\/done with HTTP 200/);
    assert.match(text, /navigating to "https:\/\/carrier\.example\/r", landed/);
  }
  // The summary's reason is one code span: GitHub renders no link, image or mention in it.
  const cells = /\| Links > seur opens a tracking page \| (.*) \|\n/.exec(summary)[1];
  assert.match(cells, /^`[^`]*\[Claim\]\(https:\/\/evil\.example\/x\) [^`]*@someone example\/repo#12 \\\| 'x'[^`]*`$/);
  // The issue job reads the reason back as one line, and shows it as a code span.
  assert.match(output, /\n- `Links > seur opens a tracking page`: Error: [^\n`]*@someone[^\n`]*\n/);
});
