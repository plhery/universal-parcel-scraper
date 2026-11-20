import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUAHAN_TRACKING, huahanAnswer, huahanPicture, huahanVerifyNumber, projectHuahanReply, runHuahanVerify } from './huahan-verify.mjs';

const number = 'HHWZZ0000000000YQ';
const url = `https://www.hh-exp.cn/WebTrack/CargoTrack.html?ordernumber=${number}`;
const capture = { captureResponses: [HUAHAN_TRACKING] };
const picture = { ask: 1, tip: ['华', '翰'], count: 2, img: 'data:image/webp;base64,UklGRg==' };
const reply = { ask: 1, msg: '', data: [{ Code: number, Error_code: '0000', Status: 'In transit', Consignee: 'PRIVATE',
  Reference: 'PRIVATE', Detail: [{ Comment: 'Departed', Occur_date: '2026-01-02 03:04:05', Status: 'DF', track_area: 'Shenzhen', Phone: 'PRIVATE' }] }] };

/** A HuaHan double answering each path from `routes`, recording what it was asked. */
function huahan(routes) {
  const asked = [];
  const fetcher = async (address, init) => {
    const path = new URL(address).pathname.replace('/WebTrack/', '');
    asked.push({ path, query: new URL(address).searchParams, cookie: init.headers.Cookie, body: init.body });
    const answer = routes[path]?.(asked.filter(entry => entry.path === path).length);
    if (answer === undefined) throw new Error(`unexpected ${path}`);
    const headers = path === 'init.php' ? { 'set-cookie': `PHPSESSID=s${asked.filter(entry => entry.path === 'init.php').length}; path=/` } : {};
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status: 200, headers });
  };
  return { asked, fetcher };
}
const opened = { 'init.php': count => ({ ask: 1, token: `token-${count}-abcdef` }), 'tncode.php': () => picture };
const sure = async () => ({ points: [{ x: 169, y: 50.5 }, { x: 77, y: 21 }], confidence: 0.999 });
const run = (fetcher, options = {}) => runHuahanVerify({ url, capture, tier: 2, maxTimeout: 5000, fetcher, onReport: () => {}, ...options });

test('HuaHan enters only the whole waybill with its tracking reply bound', () => {
  assert.equal(huahanVerifyNumber(url, capture), number);
  for (const bad of [url + '&x=1', url.replace(number, number + '0'), url + '#x', url.replace('www.hh-exp.cn', 'example.test'),
    url.replace('CargoTrack.html', 'Other.html')]) assert.equal(huahanVerifyNumber(bad, capture), null);
  assert.equal(huahanVerifyNumber(url, { captureResponses: [HUAHAN_TRACKING, HUAHAN_TRACKING] }), null);
});

test('HuaHan reads the picture prompt and the arithmetic question strictly', () => {
  assert.deepEqual(huahanPicture(picture), { targets: '华翰', image: 'UklGRg==' });
  assert.equal(huahanPicture({ ...picture, count: 3 }), null);
  assert.equal(huahanPicture({ ...picture, tip: ['华', 'A'] }), null);
  assert.equal(huahanPicture({ ...picture, img: 'https://example.test/x.webp' }), null);
  assert.equal(huahanAnswer('3 + 5 = ?'), '8');
  assert.equal(huahanAnswer('7 ÷ 2 = ?'), null);
  assert.equal(huahanAnswer('3 + 5 + 1 = ?'), null);
});

test('HuaHan keeps only the reply fields the parser reads', () => {
  const projected = projectHuahanReply(JSON.stringify(reply));
  assert.ok(!projected.includes('PRIVATE'));
  assert.equal(JSON.parse(projected).data[0].Detail[0].track_area, 'Shenzhen');
  assert.equal(projectHuahanReply('<html>'), null);
});

test('HuaHan clicks a confident reading, then posts the waybill in the same session', async () => {
  const { asked, fetcher } = huahan({ ...opened, 'check.php': () => 'ok', 'CargoTrackActionPlus.php': () => reply });
  let input;
  const result = await run(fetcher, { solve: async (value, signal, timeoutMs) => { input = value; assert.ok(timeoutMs > 0); return sure(); } });
  assert.deepEqual(input, { targets: '华翰', image: 'UklGRg==', region: { x: 0, y: 0, width: 240, height: 150 } });
  const check = asked.find(entry => entry.path === 'check.php');
  assert.equal(check.query.get('clicks'), '169,51;77,21');
  assert.equal(check.query.get('token'), 'token-1-abcdef');
  const post = asked.at(-1);
  assert.equal(post.cookie, 'PHPSESSID=s1');
  assert.equal(post.body, `ordernumber=${number}`);
  assert.equal(result.capturedResponses.length, 1);
  const [entry] = result.capturedResponses;
  assert.equal(entry.url, HUAHAN_TRACKING);
  assert.equal(entry.trackingNumberSubmitted, number);
  assert.ok(!entry.body.includes('PRIVATE'));
  assert.equal(result.html, '');
});

test('HuaHan opens a new session instead of submitting an unsure reading', async () => {
  const { asked, fetcher } = huahan({ ...opened, 'check.php': () => 'ok', 'CargoTrackActionPlus.php': () => reply });
  let readings = 0;
  const result = await run(fetcher, { solve: async () => ++readings === 1 ? { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], confidence: 0.12 } : sure() });
  assert.equal(asked.filter(entry => entry.path === 'init.php').length, 2);
  assert.equal(asked.filter(entry => entry.path === 'check.php').length, 1);
  assert.equal(asked.find(entry => entry.path === 'check.php').query.get('token'), 'token-2-abcdef');
  assert.equal(result.capturedResponses.length, 1);
});

test('HuaHan stops after two pictures that do not pass, with no capture', async () => {
  const { asked, fetcher } = huahan({ ...opened, 'check.php': () => 'error' });
  const reports = [];
  const result = await run(fetcher, { solve: sure, onReport: fields => reports.push(fields) });
  assert.equal(asked.filter(entry => entry.path === 'init.php').length, 2);
  assert.equal(asked.some(entry => entry.path === 'CargoTrackActionPlus.php'), false);
  assert.deepEqual(result.capturedResponses, []);
  assert.equal(reports[0].outcome, 'unpassed');
  assert.equal(reports[0].checks, 2);
  assert.ok(!JSON.stringify(reports).includes('token'));
});

test('HuaHan returns the hourly cap as the widget gives it, without another session', async () => {
  const { asked, fetcher } = huahan({ 'init.php': () => ({ ask: 0, msg: '请求次数已达每小时上限' }) });
  const result = await run(fetcher, { solve: sure });
  assert.equal(asked.length, 1);
  assert.deepEqual(JSON.parse(result.capturedResponses[0].body), { ask: 0, msg: '请求次数已达每小时上限' });
});

test('HuaHan reports why a reading was withheld without submitting it or retaining its contents', async () => {
  const valid = await sure();
  const cases = [
    ['missingPoints', null],
    ['missingPoints', { failure: 'PRIVATE', image: 'PRIVATE', token: 'PRIVATE' }],
    ['pointCount', { ...valid, points: valid.points.slice(0, 1) }],
    ['confidence', { ...valid, confidence: 0.12 }],
    ['coordinates', { ...valid, points: [{ x: 240, y: 1 }, valid.points[1]] }],
  ];
  for (const [reason, reading] of cases) {
    const { asked, fetcher } = huahan(opened);
    const reports = [];
    const result = await run(fetcher, { solve: async () => reading, onReport: value => reports.push(value) });
    assert.deepEqual(asked.map(row => row.path), ['init.php', 'tncode.php', 'init.php', 'tncode.php']);
    assert.deepEqual(result.capturedResponses, []);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].unsure, 2);
    assert.deepEqual(reports[0].abstentions, Object.fromEntries(
      ['missingPoints', 'pointCount', 'confidence', 'coordinates'].map(key => [key, key === reason ? 2 : 0])));
    assert.ok(!JSON.stringify(reports).includes('PRIVATE'));
    assert.ok(!JSON.stringify(reports).includes(number));
  }
});

test('HuaHan answers the arithmetic question without the reader', async () => {
  const { asked, fetcher } = huahan({ 'init.php': () => ({ ask: 1, token: 'token-text-1' }),
    'tncode.php': () => ({ ask: 1, type: 'text', question: '3 + 5 = ?' }), 'check.php': () => 'ok', 'CargoTrackActionPlus.php': () => reply });
  const result = await run(fetcher, { solve: () => { throw new Error('unexpected reader'); } });
  assert.equal(asked.find(entry => entry.path === 'check.php').query.get('answer'), '8');
  assert.equal(result.capturedResponses.length, 1);
});

test('HuaHan ends at its deadline and cancels the reader', async () => {
  const { fetcher } = huahan(opened);
  let aborted = false;
  const result = await run(fetcher, { maxTimeout: 50, solve: (input, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ failure: 'budget' }); }, { once: true });
  }) });
  assert.deepEqual(result.capturedResponses, []);
  assert.equal(aborted, true);
});
