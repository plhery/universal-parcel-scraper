import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'parcel-scraper-package-'));
// A dependency published a minute ago can be listed before the registry serves its tarball.
const REGISTRY_LAG = /\bE404\b|\bETARGET\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b/;
const INSTALL_ATTEMPTS = 3;
const INSTALL_RETRY_MS = 60_000;

function installPacked(file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync('npm', ['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',file], { cwd: scratch, stdio: 'pipe' });
      return;
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      if (attempt >= INSTALL_ATTEMPTS || !REGISTRY_LAG.test(output)) throw error;
      console.warn(`npm install of the packed tarball failed (attempt ${attempt}); retrying in ${INSTALL_RETRY_MS / 1000} s:\n${output.trim().split('\n').slice(-5).join('\n')}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INSTALL_RETRY_MS);
    }
  }
}

let tarball;
try {
  // The JSON lists every packed file, which outgrows the default 1 MiB buffer.
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))[0];
  tarball = path.join(scratch, packed.filename);
  assert(packed.files.every(file => !/fixtures|private\.numbers|\.env|\.test\.|\.git\//.test(file.path)));
  writeFileSync(path.join(scratch,'package.json'), JSON.stringify({ private: true, type: 'module' }));
  installPacked(tarball);
  const dpdAppReplies = Object.fromEntries([
    ['getSessionFullState', 'session'], ['getTrackingData', 'tracking'], ['getTrackingScanList', 'scans'],
  ].map(([operation, fixture]) => [operation, readFileSync(path.join(root, 'carriers/dpd-de/fixtures', `app-${fixture}.xml`), 'utf8')]));
  const regionalGofoReplies = Object.fromEntries(['fr', 'it'].map(region => [region,
    JSON.parse(readFileSync(path.join(root, `carriers/gofo-${region}/fixtures/delivered.json`), 'utf8'))]));
  const omgoReplies = Object.fromEntries(['tracking-page.html', 'tracking.json'].map(file => [file,
    readFileSync(path.join(root, 'carriers/omgo/fixtures', file), 'utf8')]));
  const ftdNzReply = readFileSync(path.join(root, 'carriers/ftd-nz/fixtures/tracking.html'), 'utf8');
  const paxelReply = readFileSync(path.join(root, 'carriers/paxel/fixtures/tracking.html'), 'utf8');
  const lhtexReply = JSON.parse(readFileSync(path.join(root, 'carriers/lhtex/fixtures/tracking.json'), 'utf8'));
  const ninjaReply = JSON.parse(readFileSync(path.join(root, 'carriers/ninja-van/fixtures/delivered.json'), 'utf8'));
  writeFileSync(path.join(scratch,'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync, existsSync } from 'node:fs';
    import { parseTrackingInput, CARRIER_CATALOG } from 'universal-parcel-scraper';
    import { createTracker } from 'universal-parcel-scraper/node';
    import { locatePlace } from 'universal-parcel-scraper/places';
    import * as tracking from 'universal-parcel-scraper';
    import { carrierTrackingHintKey, scanTemplate } from 'universal-parcel-scraper/app';
    import catalog from 'universal-parcel-scraper/data/catalog.json' with { type: 'json' };
    import stages from 'universal-parcel-scraper/data/stages.json' with { type: 'json' };
    import golden from 'universal-parcel-scraper/data/detection-golden.json' with { type: 'json' };
    import checksumVectors from 'universal-parcel-scraper/data/checksum-vectors.json' with { type: 'json' };
    import schema from 'universal-parcel-scraper/data/carrier.schema.json' with { type: 'json' };
    import scanTemplates from 'universal-parcel-scraper/data/scan-templates.json' with { type: 'json' };
    const template = scanTemplate('ups', { providerCode: 'AR', description: 'Arrived at Facility' });
    assert.equal(scanTemplates.templates[template.id].text.de, 'In einem Paketzentrum angekommen');
    const match = parseTrackingInput('1Z999AA10123456784');
    assert.equal(match.carrier, 'ups');
    assert.equal(createTracker({ providers: [] }).detect(match.trackingNumber).carrier, 'ups');
    // Exercise Chronopost through the installed registry, without optional browsers.
    const chronopostNumber = 'XU123456799FR';
    const chronopostXml = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
      + '<t:trackSkybillV2Response xmlns:t="http://cxf.tracking.soap.chronopost.fr/"><return><errorCode>0</errorCode><listEventInfoComp>'
      + "<events><code>TS</code><eventDate>2026-01-03T15:01:15+01:00</eventDate><eventLabel>Colis en cours d'acheminement</eventLabel></events>"
      + '<skybillNumber>' + chronopostNumber + '</skybillNumber></listEventInfoComp></return></t:trackSkybillV2Response></s:Body></s:Envelope>';
    const chronopost = await createTracker({ providers: [], fetcher: async (url, init) => {
      assert.equal(String(url), 'https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS');
      assert(init.signal instanceof AbortSignal && init.body.includes(chronopostNumber));
      return new Response(chronopostXml);
    } }).track({ number: chronopostNumber, carrier: 'chronopost' });
    assert.equal(chronopost.source, 'chronopost');
    assert.equal(chronopost.result.events[0].instant, '2026-01-03T15:01:15+01:00');
    // The installed registry must dispatch LHT to its own guest adapter.
    const lhtexReply = ${JSON.stringify(lhtexReply)};
    let lhtexCalls = 0;
    const lhtex = await createTracker({ providers: [], fetcher: async (url, init) => {
      lhtexCalls += 1;
      assert.equal(String(url), 'https://www.lhtex.com.cn/orderquery.php?waybillNo=' + lhtexReply.data[0].waybillNo);
      assert(init.signal instanceof AbortSignal);
      return Response.json(lhtexReply);
    } }).track({ number: lhtexReply.data[0].waybillNo, carrier: 'lhtex' });
    assert.equal(lhtex.source, 'lhtex');
    assert.equal(lhtex.result.status, 'delivered');
    assert.equal(lhtex.result.events.length, 8);
    assert.equal(lhtexCalls, 1);
    // Dispatch the CPU-verification carrier without starting an optional OCR peer.
    let bestFreightCalls = 0;
    try {
      await createTracker({ providers: [], fetcher: async (url, init) => {
        bestFreightCalls += 1;
        assert.equal(String(url), 'https://www.800best.com/api/general/imageverifycode');
        assert(init.signal instanceof AbortSignal);
        return new Response('rate limited', { status: 429 });
      } }).track({ number: '97468251036', carrier: 'best-freight-cn' });
      assert.fail('The refused guest request must not produce history');
    } catch { assert.equal(bestFreightCalls, 1); }
    assert(existsSync(new URL('./carriers/best-freight-cn/ocr-worker.mjs', import.meta.resolve('universal-parcel-scraper/node'))));
    assert(existsSync(new URL('./carriers/best-freight-cn/ocr-consensus.mjs', import.meta.resolve('universal-parcel-scraper/node'))));
    // Exercise the public guest OCR protocol through the installed registry and facade.
    const flashNumber = 'SYNTHETIC123'; let flashCalls = 0;
    const flash = await createTracker({ providers: [], trawlUrl: 'http://trawl.invalid', fetcher: async (_url, init) => {
      flashCalls++; const request = JSON.parse(init.body);
      assert.equal(request.url, 'https://www.flashcourier.com.br/rastreio/' + flashNumber);
      const api = 'https://www.flashcourier.com.br/api/hawb/' + flashNumber + '/tipo/todos';
      assert.deepEqual(request.captureResponses, [api]); assert.equal(request.skipHttp, true);
      return Response.json({ tier: 3, status: 'success', durationMs: 5, effectiveUrl: request.url, statusCode: 200,
        html: JSON.stringify({ protocol: 'flash-courier-guest-v1', requestedNumber: flashNumber, diagnostic: null }),
        capturedResponses: [{ url: api, status: 200, headers: {}, trackingNumberSubmitted: flashNumber,
          body: JSON.stringify({ kind: 'history', success: true, number: flashNumber, primaryNumber: '12345678901', customerReference: flashNumber,
            summary: 'Pedido entregue', events: [{ status: 'Entrega efetuada com sucesso', clock: '07/08/2026 08:57:50' }] }) }] });
    } }).track({ number: flashNumber, carrier: 'flash-courier' });
    assert.equal(flash.source, 'flash-courier'); assert.equal(flash.result.status, 'delivered');
    assert.equal(flash.result.events[0].local_time, '2026-08-07T08:57:50');
    assert.equal(flash.result.events[0].instant, '2026-08-07T08:57:50-03:00'); assert.equal(flashCalls, 1);
    // The installed forwarder keeps its incomplete history and named handoff.
    const ftdNzReply = ${JSON.stringify(ftdNzReply)};
    let ftdNzCalls = 0, ftdNzHandoffCalls = 0;
    const ftdNz = await createTracker({ providers: [], fetcher: async (url, init) => {
      if (new URL(String(url)).hostname === 'hdgateway.zto.com') {
        ftdNzHandoffCalls += 1;
        assert(String(init.body).includes('73974682510368'));
        return new Response('Synthetic downstream verification refusal', { status: 403 });
      }
      ftdNzCalls += 1;
      assert.equal(String(url), 'https://www.ftd.nz/query/?code=QXZ974682');
      assert(init.signal instanceof AbortSignal);
      return new Response(ftdNzReply);
    } }).track({ number: 'QXZ974682', carrier: 'ftd-nz' });
    assert.equal(ftdNz.source, 'ftd-nz');
    assert.equal(ftdNz.result.status, 'in_transit');
    assert.equal(ftdNz.result.events.length, 5);
    assert.equal(ftdNz.result.history_truncated, true);
    assert.equal(ftdNz.result.delivery_carrier, 'zto');
    assert.equal(ftdNz.result.delivery_tracking_number, '73974682510368');
    assert.equal(ftdNzCalls, 1);
    assert.equal(ftdNzHandoffCalls, 1);
    // Printed whole-AWB metadata must survive the browser-service/package boundary.
    const paxelPage = 'https://paxel.co/id/lacak-pengiriman';
    const paxelNumber = 'TSPX-97468251036';
    let paxelCalls = 0;
    const paxel = await createTracker({ providers: [], trawlUrl: 'http://trawl.invalid', fetcher: async (url, init) => {
      paxelCalls++;
      assert.equal(String(url), 'http://trawl.invalid/scrape');
      assert(init.signal instanceof AbortSignal);
      const request = JSON.parse(init.body);
      assert.equal(request.url, paxelPage + '?awb_req=' + paxelNumber);
      assert.deepEqual(request.captureResponses, [paxelPage]);
      return Response.json({ url: request.url, html: '', tier: 3, statusCode: 200, capturedResponses: [
        { url: paxelPage, status: 200, headers: { 'content-type': 'text/html' }, body: ${JSON.stringify(paxelReply)}, trackingNumberSubmitted: paxelNumber },
      ] });
    } }).track({ number: 'TSPX97468251036', carrier: 'paxel' });
    assert.equal(paxel.source, 'paxel');
    assert.equal(paxel.result.status, 'delivered');
    assert.equal(paxel.result.events.length, 2);
    assert.equal(paxel.result.events[0].provider_time_text, 'Nov 06 | 21:08');
    assert.equal(paxel.result.events[0].instant, null);
    assert.equal(paxel.result.history_truncated, true);
    assert.equal(paxelCalls, 1);
    // Read DPD Germany's forecast through the installed adapter and result facade.
    const dpdAppReplies = ${JSON.stringify(dpdAppReplies)};
    const dpd = await createTracker({ providers: [], fetcher: async (url, init) => {
      assert.equal(String(url), 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx');
      const operation = new Headers(init.headers).get('SOAPAction').split('/').at(-1).replaceAll('"', '');
      assert(dpdAppReplies[operation] && init.signal instanceof AbortSignal);
      return new Response(dpdAppReplies[operation]);
    } }).track({ number: '01000000000001', carrier: 'dpd-de' });
    assert.equal(dpd.result.expected_delivery, '2026-01-03');
    assert.equal(dpd.result.events.length, 5);
    // Regional GOFO lookups must load their own maps and shared implementation from the package.
    const regionalGofoReplies = ${JSON.stringify(regionalGofoReplies)};
    for (const region of ['fr', 'it']) {
      const carrier = 'gofo-' + region;
      const number = regionalGofoReplies[region].data[0].waybillNo;
      const answer = await createTracker({ providers: [], fetcher: async (url, init) => {
        assert.equal(String(url), 'https://www.gofo.com/' + region + '/open-api/official/track/queryTrackV2');
        assert(init.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(init.body), { numberList: [number] });
        return Response.json(regionalGofoReplies[region]);
      } }).track({ number, carrier });
      assert.equal(answer.source, carrier);
      assert.equal(answer.result.status, 'delivered');
      assert(answer.result.events.length >= 7);
    }
    const omgoReplies = ${JSON.stringify(omgoReplies)};
    let omgoRequests = 0;
    const omgo = await createTracker({ providers: [], fetcher: async (url, init) => {
      omgoRequests += 1;
      assert(init.signal instanceof AbortSignal);
      if (omgoRequests === 1) {
        assert.equal(new URL(url).pathname, '/track-package/');
        return new Response(omgoReplies['tracking-page.html']);
      }
      assert.equal(String(url), 'https://omgoexpress.cn/wp-admin/admin-ajax.php');
      assert.equal(init.body.get('tracking_codes'), 'OMGO9999999999980');
      return new Response(omgoReplies['tracking.json']);
    } }).track({ number: 'OMGO9999999999980', carrier: 'omgo' });
    assert.equal(omgo.source, 'omgo');
    assert.equal(omgo.result.status, 'in_transit');
    assert.equal(omgoRequests, 2);
    const ninjaReply = ${JSON.stringify(ninjaReply)};
    for (const country of ['sg', 'my', 'id', 'ph', 'th', 'vn']) {
      const number = 'NL' + country.toUpperCase() + 'A00000001';
      const answer = await createTracker({ providers: [], fetcher: async (url, init) => {
        const request = new URL(url);
        assert.equal(request.origin, 'https://walrus.ninjavan.co');
        assert.equal(request.pathname, '/' + country + '/dash/1.2/public/orders');
        assert.equal(request.searchParams.get('tracking_id'), number);
        assert(init.signal instanceof AbortSignal);
        return Response.json({ ...ninjaReply, tracking_id: number });
      } }).track({ number, carrier: 'ninja-van' });
      assert.equal(answer.source, 'ninja-van');
      assert.equal(answer.result.status, 'delivered');
      assert.equal(answer.result.events.length, ninjaReply.events.length);
      const portal = new URL(tracking.CARRIERS['ninja-van'].trackingUrl(number));
      assert.equal(portal.pathname, '/en-' + country + '/tracking');
      assert.equal(portal.searchParams.get('id'), number);
    }
    assert.deepEqual(catalog, CARRIER_CATALOG);
    assert(stages.includes('delivered') && golden.length > 0 && checksumVectors.vectors.ups.length > 0 && schema.type === 'object');
    assert.equal(locatePlace('Paris, FR').country, 'FR');
    assert.equal(locatePlace('Example TMO 800001', { countries: ['IN'] })?.name, 'Patna');
    assert.equal(typeof carrierTrackingHintKey('ups'), 'string');
    assert(!('carrierTrackingHintKey' in tracking));
    const base = new URL('.', import.meta.resolve('universal-parcel-scraper/node'));
    for (const file of ['carriers/correios-br/ocr-worker.mjs','carriers/correios-br/model/captcha.onnx','carriers/correios-br/model/LICENSE','carriers/wahana/ocr-worker.mjs',
      'carriers/viettel-post/ocr-worker.mjs','carriers/vnpost/ocr-worker.mjs','carriers/jetizz/ocr-worker.mjs','carriers/best-express-vn/rotate-worker.mjs','carriers/best-express-vn/rotate-library.json','carriers/vnpost/model/captcha.onnx','core/transport/text-captcha-worker.mjs','core/transport/text-captcha-decode.mjs','carriers/chunghwa-post/ocr-worker.mjs','carriers/chunghwa-post/captcha.mjs','core/transport/text-captcha-model/captcha.onnx','core/transport/text-captcha-model/characters.json','core/transport/text-captcha-model/arithmetic-characters.json','core/transport/text-captcha-model/LICENSE',
      'places/places.tsv.br','places/pincodes.json','places/zipcodes.json','browser/scraper.js']) assert(existsSync(new URL(file, base)), file);
    assert(!readFileSync(new URL('browser/scraper.js', base), 'utf8').includes('node:'));
  `);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: scratch, stdio: 'inherit' });
  writeFileSync(path.join(scratch,'smoke.cjs'), `
    const assert = require('node:assert/strict');
    assert.equal(require('universal-parcel-scraper').parseTrackingInput('1Z999AA10123456784').carrier, 'ups');
    assert.equal(typeof require('universal-parcel-scraper/node').createTracker, 'function');
    assert.equal(require('universal-parcel-scraper/places').locatePlace('Paris, FR').country, 'FR');
  `);
  execFileSync(process.execPath, ['smoke.cjs'], { cwd: scratch, stdio: 'inherit' });
  const cli = execFileSync(path.join(scratch, 'node_modules/.bin/parcel-scraper'), ['detect','1Z999AA10123456784'], { cwd: scratch, encoding: 'utf8' });
  assert.equal(JSON.parse(cli).carrier, 'ups');
  assert(existsSync(tarball));
  const forbidden = /"(?:next|react|@supabase|@sentry)/;
  assert(!forbidden.test(readFileSync(path.join(scratch,'node_modules/universal-parcel-scraper/package.json'),'utf8')));
  console.log(`Packed package verified: ${packed.files.length} files; all entry points load through import and require; CLI and assets work without optional dependencies.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
