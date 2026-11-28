import test from 'node:test';
import assert from 'node:assert/strict';
import { coveredTiles, detectRecaptchaObjects, pngHeight, pngWidth, recaptchaTarget, solveRecaptchaImages } from './recaptcha-image.mjs';

// A synthetic PNG header of the given size, all a screenshot's geometry needs.
const png = (width, height) => {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(0x0d0a1a0a, 4); bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
};
const grid = (side, size) => [...Array(side * side).keys()].map(index => [(index % side) * size, Math.floor(index / side) * size, size, size]);

test('names the COCO class of the targets it covers, and none for the others', () => {
  for (const [words, cls] of [['a fire hydrant', 10], ['fire hydrants', 10], ['buses', 5], ['a bus', 5], ['Bicycles', 1], ['traffic lights', 9],
    ['motorcycles', 3], ['cars', 2], ['boats', 8], ['parking meters', 12]]) assert.equal(recaptchaTarget(words), cls, words);
  for (const words of ['crosswalks', 'taxis', 'stairs', 'chimneys', 'bridges', 'palm trees', 'mountains or hills', 'tractors', '', null]) assert.equal(recaptchaTarget(words), undefined, words);
});

test('takes the squares a box covers a share of', () => {
  const tiles = grid(4, 100);
  assert.deepEqual(coveredTiles([[50, 50, 160, 120, 0.9]], tiles), [0, 1, 4, 5]);
  assert.deepEqual(coveredTiles([[97, 0, 103, 100, 0.9]], tiles), [], 'a sliver along an edge takes no square');
  assert.deepEqual(coveredTiles([], tiles), []);
});

test('reads a PNG\'s size from its header only', () => {
  assert.equal(pngWidth(png(600, 450)), 600); assert.equal(pngHeight(png(600, 450)), 450);
  assert.equal(pngWidth(Buffer.from('not a picture at all, long enough')), 0); assert.equal(pngHeight(null), 0);
});

test('starts no detector for a cancelled lookup, a short budget or an oversized picture', async () => {
  const aborted = AbortSignal.abort();
  assert.equal(await detectRecaptchaObjects({ image: png(300, 300), cls: 10, crops: [[0, 0, 300, 300]] }, aborted, 5000), null);
  assert.equal(await detectRecaptchaObjects({ image: png(300, 300), cls: 10, crops: [[0, 0, 300, 300]] }, undefined, 100), null);
  assert.equal(await detectRecaptchaObjects({ image: Buffer.alloc(1_600_000), cls: 10, crops: [[0, 0, 300, 300]] }, undefined, 5000), null);
});

// The two frames as the solver sees them, from a script of challenges.
function frames({ passes = false, challenges = [], blocked = false } = {}) {
  const state = { checked: passes, clicks: [], reloads: 0, verifies: 0, shots: 0, challenge: 0, fading: {} };
  const current = () => challenges[Math.min(state.challenge, challenges.length - 1)];
  const view = () => {
    if (blocked) return { blocked: true };
    const c = current();
    if (!c || state.checked) return { blocked: false };
    const side = Number(c.grid[0]), size = side === 3 ? 100 : 75;
    // A clicked tile of a dynamic challenge fades for one look, then shows its new picture.
    const pending = [...Array(side * side).keys()].map(index => !!c.dynamic && state.fading[index]-- > 0);
    return { grid: c.grid, target: c.target, squares: false, width: side * size, tiles: grid(side, size), pending, ready: true, picture: `p${state.challenge}`, refused: !!state.refused && !!c.stay };
  };
  const anchor = { locator: () => ({ count: async () => state.checked ? 1 : 0 }) };
  const bframe = { locator: selector => ({
    evaluate: async () => view(),
    screenshot: async () => { state.shots++; const side = Number(current().grid[0]); return png(side * (side === 3 ? 200 : 150), side * (side === 3 ? 200 : 150)); },
    click: async () => {
      if (selector === '#recaptcha-reload-button') { state.reloads++; state.challenge++; }
      if (selector === '#recaptcha-verify-button') { state.verifies++; const c = current(); if (c.solved?.(state)) state.checked = true; else if (c.stay) state.refused = true; else state.challenge++; }
    },
    nth: index => ({ click: async () => { state.clicks.push(index); state.fading[index] = 1; } }),
  }) };
  const page = { frameLocator: selector => ({ first: () => selector.includes('anchor') ? anchor : bframe }) };
  return { state, page };
}

const run = async (f, options = {}) => {
  const reports = [];
  const result = await solveRecaptchaImages(f.page, { timeoutMs: 60_000, appearMs: 50, sleep: async () => {}, report: fields => reports.push(fields), ...options });
  return { result, report: reports.at(-1) };
};

test('stops at once when the checkbox passes', async () => {
  const f = frames({ passes: true });
  const { result, report } = await run(f, { detect: async () => assert.fail('no detection') });
  assert.equal(result, true); assert.equal(report.outcome, 'checkbox'); assert.equal(report.rounds, 0);
});

test('clicks the tiles showing the target, in tile coordinates of the screenshot, and verifies', async () => {
  const seen = [];
  const f = frames({ challenges: [{ grid: '33', target: 'fire hydrants', solved: state => state.clicks.join() === '1,5' }] });
  const detect = async ({ cls, crops }) => { seen.push({ cls, crops }); return crops.map((_, index) => [1, 5].includes(index) ? [[10, 10, 90, 90, 0.8]] : []); };
  const { result, report } = await run(f, { detect });
  assert.equal(result, true); assert.deepEqual(f.state.clicks, [1, 5]); assert.equal(f.state.verifies, 1);
  assert.equal(seen[0].cls, 10); assert.deepEqual(seen[0].crops[4], [200, 200, 200, 200], 'tiles scale with the screenshot');
  assert.deepEqual(report, { outcome: 'verified', rounds: 1, waves: 0, target: 'fire hydrant' });
});

test('splits a whole picture into the squares its boxes cover', async () => {
  const f = frames({ challenges: [{ grid: '44', target: 'motorcycles', solved: state => state.clicks.join() === '0,1,4,5' }] });
  const detect = async ({ crops }) => { assert.deepEqual(crops, [[0, 0, 600, 600]]); return [[[50, 50, 200, 200, 0.7]]]; };
  const { result } = await run(f, { detect });
  assert.equal(result, true); assert.deepEqual(f.state.clicks, [0, 1, 4, 5]);
});

test('checks the pictures that replace clicked tiles until none shows the target', async () => {
  let wave = 0;
  const f = frames({ challenges: [{ grid: '33', target: 'cars', dynamic: true,
    solved: state => state.clicks.join() === '2,7,2' }] });
  const detect = async ({ crops }) => {
    wave++;
    if (wave === 1) return crops.map((_, index) => [2, 7].includes(index) ? [[0, 0, 50, 50, 0.6]] : []);
    if (wave === 2) { assert.equal(crops.length, 2); return [[[0, 0, 50, 50, 0.6]], []]; }
    assert.equal(crops.length, 1); return [[]];
  };
  const { result, report } = await run(f, { detect });
  assert.equal(result, true); assert.deepEqual(f.state.clicks, [2, 7, 2]); assert.equal(report.waves, 2);
});

test('takes a new challenge for a target no class covers, within its rounds', async () => {
  const f = frames({ challenges: [{ grid: '33', target: 'crosswalks' }] });
  const { result, report } = await run(f, { detect: async () => assert.fail('no detection') });
  assert.equal(result, false); assert.equal(f.state.reloads, 8); assert.equal(report.target, 'other'); assert.equal(report.rounds, 8);
});

test('ends on Google\'s block, a failed detector or the deadline', async () => {
  assert.equal((await run(frames({ blocked: true }), { detect: async () => [] })).report.outcome, 'blocked');
  const f = frames({ challenges: [{ grid: '33', target: 'buses' }] });
  const { result, report } = await run(f, { detect: async () => null });
  assert.equal(result, false); assert.equal(report.outcome, 'detector'); assert.deepEqual(f.state.clicks, []);
  const g = frames({ challenges: [{ grid: '33', target: 'buses' }] });
  assert.equal((await run(g, { timeoutMs: 2000, detect: async () => [] })).result, false); assert.equal(g.state.verifies, 0);
});

test('takes a new challenge rather than answer none on a grid of separate pictures', async () => {
  const f = frames({ challenges: [{ grid: '33', target: 'buses' }, { grid: '33', target: 'buses', solved: state => state.clicks.join() === '3' }] });
  let calls = 0;
  const detect = async ({ crops }) => { calls++; return crops.map((_, index) => calls > 1 && index === 3 ? [[0, 0, 10, 10, 0.5]] : []); };
  const { result } = await run(f, { detect });
  assert.equal(result, true); assert.equal(f.state.reloads, 1); assert.equal(f.state.verifies, 1); assert.deepEqual(f.state.clicks, [3]);
});

test('a refused answer on the same pictures takes a new challenge', async () => {
  const f = frames({ challenges: [{ grid: '33', target: 'bicycles', stay: true }, { grid: '33', target: 'bicycles', solved: () => true }] });
  const detect = async ({ crops }) => crops.map((_, index) => index === 0 ? [[0, 0, 10, 10, 0.5]] : []);
  const { result } = await run(f, { detect });
  assert.equal(result, true); assert.equal(f.state.reloads, 1); assert.equal(f.state.verifies, 2);
});
