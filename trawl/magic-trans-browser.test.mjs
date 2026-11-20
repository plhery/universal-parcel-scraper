import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TRANS_ORIGIN, magicTransPageUrl, magicTransBrowserNumber, boundMagicTransLookup, projectMagicTransReply,
  fillMagicTransNumber, readMagicTransToken, submitMagicTransForm, runMagicTransBrowser } from './magic-trans-browser.mjs';

const number = '000000001', url = magicTransPageUrl(number);
const capture = { captureResponses: [url] }, frame = { url: () => url };
const row = (key, value, style) => `<div class="k1-tracking__row"${style === undefined ? '' : ` style="${style}"`}>
  <div class="k1-tracking__key">${key}</div>
  <div class="k1-tracking__value">${value}</div>
</div>`;
const page = ({ shown = true, heading = `Статус груза ${number}`, dump = '', rows = '' } = {}) => `<html><body>
<div class="k1-tracking-wrapper">
  <div style="display: none;"><pre>${dump}</pre></div>
  <div class="k1-tracking" style="${shown ? ';' : 'display: none;'}"><h3>${heading}</h3>
    <div class="k1-tracking__row"><div class="k1-tracking__key k1-bold"> Статус груза <!-- TR000000002MT--> </div>
      <div class="k1-tracking__value k1-bold"> В пути </div></div>
    ${rows}
  </div>
</div></body></html>`;
const positive = page({
  dump: `stdClass Object
(
    [TrackNumber] => TR${number}MT
    [DateTimeAct] => 10.01.2026 09:15:00
    [ActNumber] => ${number}
    [TotalDocSum] => PRIVATE
    [Weight] => PRIVATE
    [NameCargo] => PRIVATE
    [SenderWareHouse] =>  Москва Беседы
    [ReceiverTerminal] => PRIVATE ###
    [DateArrivalWarehouseRecipient] => 01.01.0001
)`,
  rows: [row('Дата сдачи груза', '10.01.2026', ''), row('Прибытие груза на терминал', 'Уточнить <a href="tel:0">PRIVATE</a>', 'display:none'),
    row('Ориентировочная дата выдачи', '14.01.2026'), row('Вес, кг', 'PRIVATE'), row('Наименование груза', 'PRIVATE'),
    row('Тип доставки', 'До терминала'), row('Адрес', 'PRIVATE'), row('Телефон', '<a href="tel:0">PRIVATE</a>')].join('\n'),
});
const lookup = (body = JSON.stringify({ id: number, 'ya-token': 'token' }), extra = {}) => ({ method: () => 'POST', url: () => url,
  postData: () => body, frame: () => frame, ...extra });

function fixture({ status = 200, body = positive, timeout = 8000, token = 300, respond = true, pageStatus = 200, stall = false } = {}) {
  const handlers = {}, state = { closed: 0, pages: 0, pagesClosed: 0, policy: 0, aborted: 0, fallback: 0, heavy: 0, drags: 0, submits: 0, filled: 0 };
  const respondTo = (request, s, text = '') => handlers.response?.({ request: () => request, status: () => s,
    headers: () => ({ 'content-type': 'text/html; charset=UTF-8', 'set-cookie': 'PRIVATE' }), body: async () => Buffer.from(text) });
  const box = { locator: () => ({ first: () => ({ waitFor: async () => {}, boundingBox: async () => ({ x: 10, y: 10, width: 40, height: 40 }) }) }) };
  const checkbox = { ...box, url: () => 'https://smartcaptcha.yandexcloud.net/checkbox?sitekey=x' };
  const makePage = () => {
    const routes = [], hangs = stall && state.pages++ === 0;
    if (!hangs && !stall) state.pages++;
    const routeOf = target => routes.find(([re]) => re.test(target))?.[1];
    const send = async request => {
      await routeOf(request.url())({ request: () => request, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
    };
    const check = verdict => handlers.response?.({ request: () => ({ url: () => 'https://smartcaptcha.yandexcloud.net/check?x=1' }), status: () => 200,
      text: async () => JSON.stringify({ status: verdict }) });
    return { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
      route: async (re, f) => { routes.push([re, f]); }, close: async () => { state.pagesClosed++; },
      goto: async target => {
        await send({ method: () => 'GET', url: () => target, frame: () => frame });
        const heavy = { method: () => 'GET', url: () => 'https://mc.yandex.ru/metrika/tag.js', frame: () => frame };
        await routeOf(heavy.url())({ request: () => heavy, abort: async () => { state.heavy++; } });
        setTimeout(() => check('failed'), 2);
        return { status: () => pageStatus };
      },
      frames: () => [frame, checkbox], bringToFront: async () => {},
      mouse: { move: async () => {}, down: () => { state.drags++; return hangs ? new Promise(() => {}) : Promise.resolve(); }, up: async () => {} },
      evaluate: async (f, arg) => {
        if (f === fillMagicTransNumber) { state.filled++; return arg === number; }
        if (f === readMagicTransToken) { check(token ? 'ok' : 'failed'); return token; }
        assert.equal(f, submitMagicTransForm); state.submits++;
        if (respond) setTimeout(async () => {
          const other = lookup(JSON.stringify({ id: '000000002', 'ya-token': 'token' }));
          await send(other); const mine = lookup(); await send(mine);
          respondTo(other, 200, page({ heading: 'Статус груза 000000002' }));
          respondTo(mine, status, body);
        }, 2);
        return true;
      },
    };
  };
  const context = { newPage: async () => makePage(), close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the tracker for one whole number with its own lookup capture', () => {
  assert.equal(url, `${MAGIC_TRANS_ORIGIN}/otsledit-gruz/?id=${number}`);
  assert.equal(magicTransBrowserNumber(url, capture), number);
  const track = magicTransPageUrl(`TR${number}MT`);
  assert.equal(magicTransBrowserNumber(track, { captureResponses: [track] }), `TR${number}MT`);
  for (const u of [url.replace('https:', 'http:'), `${url}&x=1`, `${url}&id=${number}`, url.replace('magic-trans.ru', 'example.test'),
    `${MAGIC_TRANS_ORIGIN}/otsledit-gruz?id=${number}`, `${MAGIC_TRANS_ORIGIN}/otsledit-gruz/`, magicTransPageUrl('00000001'),
    magicTransPageUrl(`tr${number}mt`), magicTransPageUrl('ZZZZ000000000')]) {
    assert.equal(magicTransBrowserNumber(u, { captureResponses: [u] }), null, u);
  }
  assert.equal(magicTransBrowserNumber(url, {}), null);
  assert.equal(magicTransBrowserNumber(url, { captureResponses: [url, url] }), null);
  assert.equal(magicTransBrowserNumber(url, { captureResponses: [`${MAGIC_TRANS_ORIGIN}/otsledit-gruz/`] }), null);
});

test('binds the lookup to the whole number and a token', () => {
  const p = { mainFrame: () => frame };
  assert.equal(boundMagicTransLookup(lookup(), number, p), true);
  for (const r of [lookup(undefined, { method: () => 'GET' }), lookup(JSON.stringify({ id: `${number}0`, 'ya-token': 't' })),
    lookup(JSON.stringify({ id: number })), lookup(JSON.stringify({ id: number, 'ya-token': '' })),
    lookup(JSON.stringify({ id: number, 'ya-token': 't', x: 1 })), lookup(JSON.stringify({ id: number, 'ya-token': 't'.repeat(9000) })),
    lookup(JSON.stringify([number])), lookup('id=000000001'), lookup(undefined, { postData: () => null }),
    lookup(undefined, { url: () => `${MAGIC_TRANS_ORIGIN}/otsledit-gruz/` }), lookup(undefined, { frame: () => ({}) })]) {
    assert.equal(boundMagicTransLookup(r, number, p), false);
  }
});

test('passes on tracking fields only', () => {
  const x = JSON.parse(projectMagicTransReply(positive));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(x, { wrapper: true, captchaError: false, shown: true,
    dump: { TrackNumber: `TR${number}MT`, DateTimeAct: '10.01.2026 09:15:00', ActNumber: number, SenderWareHouse: 'Москва Беседы',
      DateArrivalWarehouseRecipient: '01.01.0001' },
    heading: `Статус груза ${number}`,
    rows: [{ key: 'Статус груза', value: 'В пути' }, { key: 'Дата сдачи груза', value: '10.01.2026' },
      { key: 'Прибытие груза на терминал', value: 'Уточнить', hidden: true }, { key: 'Ориентировочная дата выдачи', value: '14.01.2026' },
      { key: 'Тип доставки', value: 'До терминала' }] });
  const before = JSON.parse(projectMagicTransReply(page({ shown: false, heading: 'Статус груза ' })));
  assert.equal(before.shown, false); assert.deepEqual(before.dump, {}); assert.equal(before.heading, 'Статус груза');
  assert.equal(JSON.parse(projectMagicTransReply(page().replace('k1-tracking-wrapper">', 'k1-tracking-wrapper"><i class="k1-captcha-error-js"></i>'))).captchaError, true);
  assert.deepEqual(JSON.parse(projectMagicTransReply('<html>maintenance</html>')), { wrapper: false });
  assert.equal(projectMagicTransReply(null), 'null');
});

test('drags the slider, lets the page post the number and captures only that lookup', async () => {
  const f = fixture(); const r = await runMagicTransBrowser(f.options);
  assert.equal(r.reason, 'magic-trans-reply'); assert.equal(f.state.drags, 1); assert.equal(f.state.submits, 1); assert.equal(f.state.filled, 1);
  assert.equal(f.state.aborted, 1); assert.equal(f.state.fallback, 2); assert.equal(f.state.heavy, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].url, url); assert.equal(JSON.parse(r.capturedResponses[0].body).heading, `Статус груза ${number}`);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('gives up a page whose mouse hangs for a fresh one in the same context', async () => {
  const f = fixture({ stall: true, timeout: 20000 }); const r = await runMagicTransBrowser(f.options);
  assert.equal(r.reason, 'magic-trans-reply'); assert.equal(f.state.pages, 2); assert.equal(f.state.pagesClosed, 1);
  assert.equal(f.state.drags, 2); assert.equal(f.state.submits, 1); assert.equal(f.state.policy, 2); assert.equal(f.state.closed, 1);
});

test('reports a check that never issued its token without posting', async () => {
  const f = fixture({ token: 0, timeout: 40000 }); const r = await runMagicTransBrowser(f.options);
  assert.equal(r.reason, 'magic-trans-unverified'); assert.equal(f.state.drags, 3); assert.equal(f.state.submits, 0);
  assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
});

test('keeps a refused lookup and a challenge in its place', async () => {
  const refused = await runMagicTransBrowser(fixture({ status: 403, body: '<title>403 Forbidden</title>' }).options);
  assert.equal(refused.capturedResponses[0].status, 403); assert.equal(refused.capturedResponses[0].body, '');
  const challenged = await runMagicTransBrowser(fixture({ body: '<html><title>Just a moment...</title></html>' }).options);
  assert.equal(challenged.capturedResponses[0].error, 'challenge-html');
});

test('stops at a page the tracker refuses and reports a lookup that never came', async () => {
  const blocked = fixture({ pageStatus: 403 }); const b = await runMagicTransBrowser(blocked.options);
  assert.equal(b.reason, 'magic-trans-capture_missing'); assert.equal(b.statusCode, 403); assert.equal(blocked.state.drags, 0);
  const f = fixture({ respond: false, timeout: 4000 }); const r = await runMagicTransBrowser(f.options);
  assert.equal(r.reason, 'magic-trans-capture_missing'); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runMagicTransBrowser({ ...fixture().options, url: `${MAGIC_TRANS_ORIGIN}/otsledit-gruz/` }), undefined);
});
