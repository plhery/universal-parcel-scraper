import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GINTRACOM_ORIGIN, gintracomPageUrl, gintracomLookupUrl, gintracomBrowserNumber, boundGintracomLookup,
  projectGintracomReply, runGintracomBrowser } from './gintracom-browser.mjs';

const number = '0000000001', url = gintracomPageUrl(number), lookupUrl = gintracomLookupUrl();
const capture = { captureResponses: [lookupUrl] }, frame = {};
const payload = { guia: number, ciudad: 'PRIVATE', tienda: 'PRIVATE', contenido: 'PRIVATE', valor: { texto: 'PRIVATE', cobra: true },
  estado: { codigo: 'reparto', titulo: 'En reparto', texto: 'Tu pedido está en camino.', tono: 'PRIVATE' }, intentos_contacto: 0, etapa: 2,
  fecha_clave: { etiqueta: 'Entrega', fecha: 'hoy' }, riesgo: { nivel: 'bajo', texto: 'PRIVATE' }, oficina: { direccion: 'PRIVATE' },
  historial: [{ texto: 'En reparto', fecha: '3 mar · 08:10', tipo: 'reparto', extra: 'PRIVATE' },
    { texto: 'Guía generada', fecha: '2 mar · 16:42', tipo: 'inicio' }],
  elegir_dia: { disponible: true, pregunta: 'PRIVATE', dias: ['PRIVATE'] } };
const notFound = { message: 'No encontramos esa guía. Revisa el número e inténtalo de nuevo.' };
const refused = { status: 422, body: JSON.stringify({ message: 'Verificación de captcha fallida.' }) };
const lookup = (extra = {}) => ({ method: () => 'POST', url: () => lookupUrl,
  postData: () => JSON.stringify({ guia: number, recaptcha_token: 'PRIVATE' }), frame: () => frame, ...extra });

function fixture({ body = JSON.stringify(payload), status = 200, timeout = 1000, respond: answer = true, answers = [{ status, body }],
  pictures = false } = {}) {
  const handlers = {}, state = { closed: 0, policy: 0, aborted: 0, fallback: 0, loads: 0 };
  let route;
  const respond = (request, s, headers, text = '') => handlers.response?.({ request: () => request, status: () => s, headers: () => headers,
    body: async () => Buffer.from(text) });
  // Each load of the page posts the guide once, with the next answer.
  const load = () => {
    const n = state.loads++, next = answers[n];
    if (answer && next) setTimeout(async () => {
      const other = lookup({ postData: () => JSON.stringify({ guia: '0000000002', recaptcha_token: 'PRIVATE' }) });
      if (!n) await route({ request: () => other, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
      const post = lookup();
      await route({ request: () => post, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
      if (!n) respond(other, 200, { 'content-type': 'application/json' }, JSON.stringify({ ...payload, guia: '0000000002' }));
      respond(post, next.status, { 'content-type': 'application/json', 'set-cookie': 'PRIVATE' }, next.body);
    }, 2);
    return { status: () => 200 };
  };
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(lookupUrl)); assert.ok(re.test(`${GINTRACOM_ORIGIN}/api/v1/tracking/elegir-dia`));
      assert.equal(re.test(`${GINTRACOM_ORIGIN}/api/v1/auth/captcha-config`), false); route = f; },
    goto: async () => load(), reload: async () => load(),
    url: () => url, bringToFront: async () => {},
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    locator: selector => ({ first: () => ({ isVisible: async () => pictures && selector.includes('bframe') }) }),
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the tracker page for one whole guide with its own lookup capture', () => {
  assert.equal(url, 'https://ec.gintracom.site/tracking?guia=0000000001');
  assert.equal(gintracomBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), `${url}&x=1`, `${url}&guia=0000000002`, url.replace('/tracking?', '/tracking/?'),
    url.replace('ec.gintracom.site', 'example.test'), `${GINTRACOM_ORIGIN}/tracking`, gintracomPageUrl('000 0001'), gintracomPageUrl('00001'),
    gintracomPageUrl('abc0000001')]) {
    assert.equal(gintracomBrowserNumber(u, capture), null, u);
  }
  assert.equal(gintracomBrowserNumber(url, { captureResponses: [`${lookupUrl}?x=1`] }), null);
  assert.equal(gintracomBrowserNumber(url, { captureResponses: [lookupUrl, lookupUrl] }), null);
});

test('binds the lookup to the whole guide', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundGintracomLookup(lookup(), number, page), true);
  assert.equal(boundGintracomLookup(lookup({ postData: () => JSON.stringify({ recaptcha_token: '', guia: number }) }), number, page), true);
  for (const r of [lookup({ method: () => 'GET' }), lookup({ postData: () => JSON.stringify({ guia: `${number}0` }) }),
    lookup({ postData: () => JSON.stringify({ guia: number, fecha: 'x', ultimos4: '0000' }) }), lookup({ postData: () => null }),
    lookup({ postData: () => JSON.stringify([number]) }), lookup({ url: () => `${GINTRACOM_ORIGIN}/api/v1/tracking/elegir-dia` }),
    lookup({ url: () => `${lookupUrl}?guia=${number}` }), lookup({ url: () => lookupUrl.replace('ec.gintracom.site', 'example.test') }),
    lookup({ frame: () => ({}) })]) {
    assert.equal(boundGintracomLookup(r, number, page), false);
  }
});

test('passes on tracking fields only', () => {
  const x = JSON.parse(projectGintracomReply(payload));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(x, { guia: number, etapa: 2, intentos_contacto: 0,
    estado: { codigo: 'reparto', titulo: 'En reparto', texto: 'Tu pedido está en camino.' }, fecha_clave: { etiqueta: 'Entrega', fecha: 'hoy' },
    historial: [{ texto: 'En reparto', fecha: '3 mar · 08:10', tipo: 'reparto' }, { texto: 'Guía generada', fecha: '2 mar · 16:42', tipo: 'inicio' }] });
  for (const y of [null, [], 'x']) assert.equal(projectGintracomReply(y), 'null');
  assert.deepEqual(JSON.parse(projectGintracomReply(notFound)), notFound);
  assert.equal(JSON.parse(projectGintracomReply({ guia: number, historial: {} })).historial, null);
});

test('captures the page’s own lookup and stops other guides', async () => {
  const f = fixture(); const r = await runGintracomBrowser(f.options);
  assert.equal(r.reason, 'gintracom-reply'); assert.equal(f.state.aborted, 1); assert.equal(f.state.fallback, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].url, lookupUrl);
  assert.equal(JSON.parse(r.capturedResponses[0].body).historial.length, 2);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('keeps the tracker’s answer for an unknown guide and marks a page that is not JSON', async () => {
  const unknown = await runGintracomBrowser(fixture({ status: 404, body: JSON.stringify(notFound) }).options);
  assert.equal(unknown.capturedResponses[0].status, 404); assert.deepEqual(JSON.parse(unknown.capturedResponses[0].body), notFound);
  const html = await runGintracomBrowser(fixture({ body: '<html>PRIVATE</html>' }).options);
  assert.equal(html.capturedResponses[0].error, 'invalid-json'); assert.equal(JSON.stringify(html).includes('PRIVATE'), false);
  const challenge = await runGintracomBrowser(fixture({ status: 404, body: '<title>Just a moment...</title>PRIVATE' }).options);
  assert.equal(challenge.capturedResponses[0].error, 'challenge-html');
  const blocked = await runGintracomBrowser(fixture({ status: 403, body: 'PRIVATE' }).options);
  assert.equal(blocked.capturedResponses[0].status, 403); assert.equal(blocked.capturedResponses[0].body, '');
});

test('reloads the page once for a new token when reCAPTCHA refuses the first', async () => {
  const once = fixture({ timeout: 20000, answers: [refused, { status: 200, body: JSON.stringify(payload) }] });
  const r = await runGintracomBrowser(once.options);
  assert.equal(once.state.loads, 2); assert.equal(r.capturedResponses.length, 2);
  assert.equal(r.capturedResponses[0].error, 'recaptcha-refused'); assert.equal(r.capturedResponses[0].body, '');
  assert.equal(r.capturedResponses[1].status, 200); assert.equal(JSON.parse(r.capturedResponses[1].body).guia, number);
  const twice = fixture({ timeout: 20000, answers: [refused, refused, refused] });
  const t = await runGintracomBrowser(twice.options);
  assert.equal(twice.state.loads, 2); assert.deepEqual(t.capturedResponses.map(x => x.error), ['recaptcha-refused', 'recaptcha-refused']);
  const late = fixture({ answers: [refused, refused] });
  assert.equal((await runGintracomBrowser(late.options)).capturedResponses.length, 1); assert.equal(late.state.loads, 1);
});

test('reports a lookup that never came, and pictures reCAPTCHA asks for', async () => {
  const f = fixture({ respond: false, timeout: 300 }); const r = await runGintracomBrowser(f.options);
  assert.equal(r.reason, 'gintracom-capture_missing'); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
  const p = fixture({ respond: false, timeout: 5000, pictures: true }); const started = Date.now(); const q = await runGintracomBrowser(p.options);
  assert.equal(q.reason, 'gintracom-recaptcha-pictures'); assert.ok(Date.now() - started < 4000); assert.equal(p.state.closed, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runGintracomBrowser({ ...fixture().options, url: `${GINTRACOM_ORIGIN}/tracking` }), undefined);
});
