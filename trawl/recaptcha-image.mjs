import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Google's audio challenge is refused from the service's address for hours at a time, and the
// checkbox then asks for pictures instead. A local object detector finds the class the
// challenge names in its tiles; the challenge's pictures, answers and tokens are kept nowhere.
export const RECAPTCHA_ANCHOR = 'iframe[src*="recaptcha"][src*="anchor"]';
const BFRAME = 'iframe[src*="recaptcha"][src*="bframe"]';
const MAX_IMAGE = 1_500_000;
const MAX_ROUNDS = 8;
const MAX_WAVES = 4;
// The challenge's targets that COCO's classes cover, by the English words of its instruction.
// Taxis, crosswalks, stairs, chimneys, bridges, palm trees, mountains and tractors have none.
const CLASSES = new Map(Object.entries({ bicycle: 1, car: 2, motorcycle: 3, bus: 5, boat: 8, 'traffic light': 9, 'fire hydrant': 10, 'parking meter': 12 }));
let active = 0;

/** The COCO class of the challenge's target words ("a fire hydrant", "buses"), when one covers it. */
export function recaptchaTarget(words) {
  const name = String(words ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^(?:an?|the) /, '');
  return CLASSES.get(name) ?? CLASSES.get(name.replace(/s$/, '')) ?? CLASSES.get(name.replace(/es$/, ''));
}

/** The tiles of one picture split into squares that a box covers a share of. */
export function coveredTiles(boxes, tiles, share = 0.05) {
  return tiles.flatMap(([x, y, w, h], index) => boxes.some(([x1, y1, x2, y2]) => {
    const across = Math.max(0, Math.min(x + w, x2) - Math.max(x, x1)), down = Math.max(0, Math.min(y + h, y2) - Math.max(y, y1));
    return across * down >= share * w * h;
  }) ? [index] : []);
}

/** A PNG's width in pixels, read from its header. */
export function pngWidth(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR' ? bytes.readUInt32BE(16) : 0;
}

/** A PNG's height in pixels, read from its header. */
export function pngHeight(bytes) {
  return pngWidth(bytes) ? bytes.readUInt32BE(20) : 0;
}

const validBoxes = (value, count) => Array.isArray(value?.boxes) && value.boxes.length === count && value.boxes.every(list =>
  Array.isArray(list) && list.length <= 50 && list.every(box => Array.isArray(box) && box.length === 5 && box.every(Number.isFinite)));

/** Disposable detection of one class in crops of a picture, with no page, token or picture kept. */
export function detectRecaptchaObjects({ image, cls, crops }, signal, timeoutMs) {
  if (signal?.aborted || timeoutMs < 500 || active >= 2 || !Buffer.isBuffer(image) || image.length > MAX_IMAGE) return Promise.resolve(null);
  active++;
  return new Promise(resolve => {
    let output = '', invalid = false;
    const child = spawn('/opt/zto-ocr/bin/python', [fileURLToPath(new URL('./recaptcha-image.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1' } });
    const stop = () => { invalid = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, Math.min(10_000, timeoutMs));
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 65_536) stop(); });
    child.stdin.on('error', () => {});
    child.on('error', () => { invalid = true; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop); active--;
      try {
        const answer = !invalid && code === 0 ? JSON.parse(output) : null;
        resolve(validBoxes(answer, crops.length) ? answer.boxes : null);
      } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify({ image: `data:image/png;base64,${image.toString('base64')}`, class: cls, crops }));
  });
}

// The challenge as its frame shows it, read in the frame: the target's words, the grid, where each
// tile sits in the table, which tiles wait for a new picture, and Google's verdicts by class name.
function challengeState() {
  const shown = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const table = document.querySelector('#rc-imageselect-target table');
  if (!shown(table)) return { blocked: shown(document.querySelector('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text')) };
  const box = table.getBoundingClientRect(), cells = [...table.querySelectorAll('td')];
  const images = [...table.querySelectorAll('img')];
  return {
    grid: /rc-imageselect-table-(\d\d)/.exec(table.className)?.[1] ?? '',
    target: (document.querySelector('.rc-imageselect-desc strong, .rc-imageselect-desc-no-canonical strong')?.textContent ?? '').slice(0, 60),
    squares: /\bsquares\b/i.test(document.querySelector('.rc-imageselect-instructions')?.textContent ?? ''),
    width: box.width,
    tiles: cells.map(cell => {
      const area = (cell.querySelector('.rc-image-tile-wrapper') ?? cell).getBoundingClientRect();
      return [area.left - box.left, area.top - box.top, area.width, area.height];
    }),
    pending: cells.map(cell => cell.classList.contains('rc-imageselect-dynamic-selected')),
    ready: images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0),
    picture: images[0]?.src ?? '',
    refused: [...document.querySelectorAll('.rc-imageselect-incorrect-response, .rc-imageselect-error-select-more, .rc-imageselect-error-dynamic-more, .rc-imageselect-error-select-something')].some(shown),
  };
}

const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Answer the picture challenge the checkbox raised, within bounded rounds and the time given, and
 * say whether the checkbox passed. A target no class covers takes a new challenge.
 */
export async function solveRecaptchaImages(page, { timeoutMs, signal, detect = detectRecaptchaObjects, report = () => {}, now = Date.now, appearMs = 7000, sleep = pause } = {}) {
  const deadline = now() + timeoutMs, left = () => deadline - now();
  const anchor = page.frameLocator(RECAPTCHA_ANCHOR).first(), bframe = page.frameLocator(BFRAME).first();
  const passed = () => anchor.locator('#recaptcha-anchor[aria-checked="true"]').count().then(count => count > 0, () => false);
  const read = () => bframe.locator('body').evaluate(challengeState, undefined, { timeout: Math.max(1, Math.min(2000, left())) }).catch(() => null);
  const settle = async (ready, ms) => {
    const end = Math.min(deadline, now() + ms);
    for (let state = await read(); ; state = await read()) {
      if (ready(state) || now() >= end || signal?.aborted) return state;
      await sleep(200, signal);
    }
  };
  const tile = index => bframe.locator('#rc-imageselect-target td').nth(index).click({ timeout: Math.max(1, Math.min(2000, left())) });
  const control = selector => bframe.locator(selector).click({ timeout: Math.max(1, Math.min(2000, left())) }).catch(() => {});
  const shoot = async state => {
    const image = await bframe.locator('#rc-imageselect-target table').screenshot({ type: 'png', timeout: Math.max(1, Math.min(3000, left())) });
    const scale = pngWidth(image) / state.width;
    const width = pngWidth(image), height = pngHeight(image);
    if (!(scale > 0.5 && scale < 4)) return null;
    // Rounding can put a tile's edge a pixel past the picture's.
    const tiles = state.tiles.map(([x, y, w, h]) => {
      const left = Math.min(width, Math.max(0, Math.round(x * scale))), top = Math.min(height, Math.max(0, Math.round(y * scale)));
      return [left, top, Math.min(width - left, Math.round(w * scale)), Math.min(height - top, Math.round(h * scale))];
    });
    return { image, tiles, width, height };
  };
  let rounds = 0, waves = 0, outcome = 'timeout', target = 'none';
  try {
    // The checkbox's own verdict comes first: it passes, or it shows a challenge.
    for (const end = Math.min(deadline, now() + appearMs); ; await sleep(200, signal)) {
      if (await passed()) { outcome = 'checkbox'; return true; }
      const state = await read();
      if (state?.grid || state?.blocked || now() >= end || signal?.aborted) break;
    }
    while (rounds < MAX_ROUNDS && left() > 3000 && !signal?.aborted) {
      if (await passed()) { outcome = 'verified'; return true; }
      const state = await settle(found => !found || found.blocked || found.ready, 3000);
      if (!state?.grid) { outcome = state?.blocked ? 'blocked' : 'missing'; return false; }
      rounds++;
      const cls = recaptchaTarget(state.target);
      target = cls === undefined ? 'other' : [...CLASSES].find(([, value]) => value === cls)[0];
      const whole = state.grid === '44' || state.squares;
      if (cls === undefined || !['33', '44'].includes(state.grid)) {
        await control('#recaptcha-reload-button'); await sleep(1500, signal); continue;
      }
      const shot = await shoot(state);
      if (!shot) { outcome = 'geometry'; return false; }
      const boxes = await detect({ image: shot.image, cls, crops: whole ? [[0, 0, shot.width, shot.height]] : shot.tiles }, signal, Math.min(10_000, left() - 2000));
      // A detector given too little time answers nothing, as a failed one does.
      if (!boxes) { outcome = left() <= 2500 ? 'timeout' : 'detector'; return false; }
      let picks = whole ? coveredTiles(boxes[0], shot.tiles) : boxes.flatMap((found, index) => found.length ? [index] : []);
      // A grid of separate pictures always shows the target: Google refuses an answer that finds none, so a new
      // challenge costs less than that refusal.
      if (!whole && !picks.length) { await control('#recaptcha-reload-button'); await sleep(1500, signal); continue; }
      for (const index of picks) { await tile(index); await sleep(120 + Math.floor(Math.random() * 180), signal); }
      // A tile that fades out takes a new picture, which must be checked in turn until none shows the target.
      for (let wave = 0; wave < MAX_WAVES && picks.length && !whole && left() > 3000; wave++) {
        const after = await read();
        if (!picks.some(index => after?.pending?.[index])) break;
        const fresh = await settle(found => found?.grid && !found.pending.some(Boolean) && found.ready, 8000);
        if (!fresh?.grid || fresh.pending.some(Boolean)) break;
        const next = await shoot(fresh);
        if (!next) break;
        const found = await detect({ image: next.image, cls, crops: picks.map(index => next.tiles[index]) }, signal, Math.min(10_000, left() - 2000));
        if (!found) break;
        waves++;
        picks = picks.filter((_, at) => found[at].length);
        for (const index of picks) { await tile(index); await sleep(120 + Math.floor(Math.random() * 180), signal); }
      }
      await control('#recaptcha-verify-button');
      // Google answers within moments: the checkbox ticks, the frame refuses or blocks, or a new challenge follows.
      let verdict = null;
      for (const end = Math.min(deadline, now() + 6000); now() < end && !signal?.aborted; await sleep(200, signal)) {
        if (await passed()) { outcome = 'verified'; return true; }
        verdict = await read();
        if (verdict?.blocked || verdict?.refused || (verdict?.grid && verdict.ready && verdict.picture !== state.picture)) break;
      }
      if (verdict?.blocked) { outcome = 'blocked'; return false; }
      // Asked to pick more on the same pictures: a new challenge is a fairer try than a guess.
      if (verdict?.refused && verdict.picture === state.picture) { await control('#recaptcha-reload-button'); await sleep(1500, signal); }
      outcome = verdict?.refused ? 'refused' : 'unfinished';
    }
    return false;
  } catch {
    outcome = 'error';
    return false;
  } finally {
    try { report({ outcome, rounds, waves, target }); } catch { /* Diagnostics cannot change the answer. */ }
  }
}
