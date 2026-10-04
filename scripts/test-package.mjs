import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'parcel-scraper-package-'));
let tarball;
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' }))[0];
  tarball = path.join(scratch, packed.filename);
  assert(packed.files.every(file => !/fixtures|private\.numbers|\.env|\.test\.|\.git\//.test(file.path)));
  writeFileSync(path.join(scratch,'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund',tarball], { cwd: scratch, stdio: 'pipe' });
  writeFileSync(path.join(scratch,'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync, existsSync } from 'node:fs';
    import { parseTrackingInput, CARRIER_CATALOG } from 'universal-parcel-scraper';
    import { createTracker } from 'universal-parcel-scraper/node';
    import { locatePlace } from 'universal-parcel-scraper/places';
    import * as tracking from 'universal-parcel-scraper';
    import { carrierTrackingHintKey } from 'universal-parcel-scraper/app';
    import catalog from 'universal-parcel-scraper/data/catalog.json' with { type: 'json' };
    import stages from 'universal-parcel-scraper/data/stages.json' with { type: 'json' };
    import golden from 'universal-parcel-scraper/data/detection-golden.json' with { type: 'json' };
    import schema from 'universal-parcel-scraper/data/carrier.schema.json' with { type: 'json' };
    const match = parseTrackingInput('1Z999AA10123456784');
    assert.equal(match.carrier, 'ups');
    assert.equal(createTracker({ providers: [] }).detect(match.trackingNumber).carrier, 'ups');
    assert.deepEqual(catalog, CARRIER_CATALOG);
    assert(stages.includes('delivered') && golden.length > 0 && schema.type === 'object');
    assert.equal(locatePlace('Paris, FR').country, 'FR');
    assert.equal(typeof carrierTrackingHintKey('ups'), 'string');
    assert(!('carrierTrackingHintKey' in tracking));
    const base = new URL('.', import.meta.resolve('universal-parcel-scraper/node'));
    for (const file of ['carriers/correios-br/ocr-worker.mjs','carriers/correios-br/model/captcha.onnx','carriers/correios-br/model/LICENSE','places/places.tsv.br','browser/scraper.js']) assert(existsSync(new URL(file, base)), file);
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
