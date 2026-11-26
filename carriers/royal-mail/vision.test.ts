import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planRoyalMailVision } from './vision-model.js';
import { royalMailVisionGrid, royalMailVisionRecovery, type RoyalMailVerificationRecord, type RoyalMailVisionContext } from './vision.js';

vi.mock('./vision-model.js', () => ({ planRoyalMailVision: vi.fn() }));

beforeEach(() => { vi.mocked(planRoyalMailVision).mockReset(); });

async function harness() {
  const png = await sharp({ create: { width: 200, height: 260, channels: 4, background: '#aaccee' } }).png().toBuffer();
  const state = { proof: false, signature: 'Drag the synthetic object to its matching shape', frameUrl: 'https://newassets.hcaptcha.com/hcaptcha.html#frame=challenge&id=synthetic-widget',
    image: png, ready: true, submitted: false, x: 0, submitLabel: 'Skip', afterAnswer: 'Verify', nextAfterAnswer: 'Verify',
    refreshable: false, refreshedSignature: 'Drag the synthetic object to its matching shape', serial: 0 };
  const others = await Promise.all(['#ccaaee', '#eeccaa', '#aaeecc', '#eeaacc'].map(background =>
    sharp({ create: { width: 200, height: 260, channels: 4, background } }).png().toBuffer()));
  const emitter = new EventEmitter();
  // Next shows the task's second page in the same generation; Verify submits the answer.
  const submit = { getAttribute: async () => state.submitLabel, innerText: async () => state.submitLabel, click: vi.fn(async () => {
    if (/^Next/.test(state.submitLabel)) {
      state.image = others[state.serial++ % others.length]!; state.submitLabel = 'Skip'; state.afterAnswer = state.nextAfterAnswer; return;
    }
    state.submitted = true; state.proof = true;
  }) };
  // A refresh issues a new task in a new generation.
  const refreshControl = { isVisible: async () => state.refreshable, click: vi.fn(async () => {
    emitter.emit('request', { ...request(), url: () => 'https://api.hcaptcha.com/getcaptcha/synthetic-sitekey' });
    state.image = others[state.serial++ % others.length]!; state.signature = state.refreshedSignature;
  }) };
  const crop = { evaluate: async () => state.ready, screenshot: vi.fn(async () => state.image), boundingBox: async () => ({ x: state.x, y: 0, width: 200, height: 260 }) };
  const frame = { url: () => state.frameUrl, isDetached: () => false, locator: (selector: string) => {
    if (selector === '.challenge-view') return crop;
    if (selector === 'canvas') return { count: async () => 1, boundingBox: async () => ({ x: 0, y: 60, width: 200, height: 200 }) };
    if (selector === '.prompt-text') return { innerText: async () => state.signature };
    if (selector === '.button-submit') return submit;
    if (selector.startsWith('.refresh')) return { first: () => refreshControl };
    throw new Error('Unexpected fixture selector');
  } };
  const mouse = { click: vi.fn(async () => { state.submitLabel = state.afterAnswer; }), move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => { state.submitLabel = 'Verify'; }) };
  const install = vi.fn(async (...args: unknown[]) => args.length === 2);
  const page = Object.assign(emitter, { locator: () => ({ elementHandle: async () => ({ contentFrame: async () => frame, evaluate: install }) }),
    evaluate: async () => state.proof, mouse }) as unknown as Page;
  const controller = new AbortController();
  const records: RoyalMailVerificationRecord[] = [];
  const context: RoyalMailVisionContext = { options: { apiKey: 'synthetic-key', onVerification: (record: RoyalMailVerificationRecord) => { records.push(record); } }, attempt: { used: false } };
  let remaining = 30_000;
  const recovery = royalMailVisionRecovery(page, context, controller.signal, () => remaining);
  const request = (ownFrame = true) => ({ url: () => 'https://api.hcaptcha.com/checkcaptcha/synthetic-sitekey',
    method: () => 'POST', frame: () => ownFrame ? frame : {} }) as Request;
  const refusal = (status = 200, ownFrame = true) => {
    const bound = request(ownFrame);
    emitter.emit('request', bound);
    emitter.emit('response', { request: () => bound, status: () => status,
      headers: () => ({}), body: async () => Buffer.from(JSON.stringify({ pass: false })) });
  };
  vi.mocked(planRoyalMailVision).mockResolvedValue({ action: 'drag', points: [{ x: 300, y: 600 }, { x: 800, y: 750 }] });
  return { ...recovery, controller, state, mouse, submit, context, records, emitter, refusal, crop, install, refreshControl,
    refresh: () => { emitter.emit('request', { ...request(), url: () => 'https://api.hcaptcha.com/getcaptcha/synthetic-sitekey' }); },
    autoAccept: () => { state.proof = true; emitter.emit('request', request()); },
    autoCheck: () => { emitter.emit('request', request()); },
    spendBudget: () => { remaining = 2501; }, signal: controller.signal };
}

describe('Royal Mail verification recovery', () => {
  it('requires a fresh official proof and reports history separately from accepted verification', async () => {
    const h = await harness();
    await expect(h.solve(h.signal)).resolves.toBe(true);
    expect(h.mouse.down).toHaveBeenCalledOnce();
    expect(h.submit.click).toHaveBeenCalledOnce();
    h.finish(false);
    expect(h.records).toEqual([expect.objectContaining({ outcome: 'accepted', accepted: true, history: false, modelCalls: 1 })]);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('accepts automatic verification after the gesture without submitting the form again', async () => {
    const h = await harness();
    h.mouse.up.mockImplementationOnce(async () => { h.autoAccept(); });
    await expect(h.solve(h.signal)).resolves.toBe(true);
    expect(h.mouse.down).toHaveBeenCalledOnce();
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(true);
    expect(h.records[0]).toMatchObject({ accepted: true, history: true, actions: 1 });
  });

  it('does not duplicate a pending automatic verification', async () => {
    const h = await harness();
    h.mouse.up.mockImplementationOnce(async () => { h.autoCheck(); });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.mouse.down).toHaveBeenCalledOnce();
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]).toMatchObject({ outcome: 'timeout', actions: 1, checks: 1, submissions: 0 });
  });

  it('declines a multi-page task before inference or gestures', async () => {
    const h = await harness();
    h.state.submitLabel = 'Next Challenge, page 1 of 2';
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(planRoyalMailVision).not.toHaveBeenCalled();
    expect(h.mouse.down).not.toHaveBeenCalled();
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]).toMatchObject({ outcome: 'unsupported', actions: 0, modelCalls: 0 });
    expect(h.context.attempt.used).toBe(false);
  });

  it('does not advance a multi-page task whose Next control appears after answering', async () => {
    const h = await harness();
    h.mouse.up.mockImplementationOnce(async () => { h.state.submitLabel = 'Next'; });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.mouse.down).toHaveBeenCalledOnce();
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]).toMatchObject({ outcome: 'unsupported', actions: 1, submissions: 0 });
  });

  it('also preserves automatic verification that starts during the last control check', async () => {
    const h = await harness();
    let reads = 0;
    h.submit.getAttribute = async () => {
      if (++reads === 2) h.autoCheck();
      return 'Verify';
    };
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]).toMatchObject({ actions: 1, checks: 1, submissions: 0 });
  });

  it('binds the SDK completion event to the exact frame, vendor origin and current widget without retaining its token', async () => {
    const h = await harness();
    await h.solve(h.signal);
    h.finish(false);
    const installer = h.install.mock.calls[0]![0] as (node: unknown, id: string) => boolean;
    let listener: (event: unknown) => void = () => {};
    const root: { __royalMailVision?: { id: string; armed: boolean; passed: boolean };
      addEventListener: (name: string, callback: unknown) => void } = {
      addEventListener: (_name, callback) => { listener = callback as (event: unknown) => void; },
    };
    class WidgetFrame { contentWindow = {}; }
    vi.stubGlobal('window', root);
    vi.stubGlobal('HTMLIFrameElement', WidgetFrame);
    try {
      const frame = new WidgetFrame();
      expect(installer(frame, 'synthetic-widget')).toBe(true);
      const response = 'SYNTHETIC_RESPONSE_ONLY'.repeat(2);
      const data = { source: 'hcaptcha', id: 'synthetic-widget', label: 'challenge-closed',
        contents: { event: 'challenge-passed', response } };
      const event = { isTrusted: true, source: frame.contentWindow, origin: 'https://newassets.hcaptcha.com', data };
      listener(event);
      expect(root.__royalMailVision?.passed).toBe(false);
      root.__royalMailVision!.armed = true;
      for (const other of [{ ...event, origin: 'https://hcaptcha.com.evil.invalid' }, { ...event, source: {} },
        { ...event, isTrusted: false }, { ...event, data: { ...data, id: 'other-widget' } }]) {
        listener(other);
        expect(root.__royalMailVision?.passed).toBe(false);
      }
      listener({ ...event, data: JSON.stringify(data) });
      expect(root.__royalMailVision?.passed).toBe(true);
      expect(JSON.stringify(root.__royalMailVision)).not.toContain(response);
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not reuse an earlier proof or attempt', async () => {
    const h = await harness();
    h.state.proof = true;
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(planRoyalMailVision).not.toHaveBeenCalled();
    h.finish(false);
    const next = await harness();
    next.context.attempt.used = true;
    await expect(next.solve(next.signal)).resolves.toBe(false);
    expect(next.mouse.click).not.toHaveBeenCalled();
    next.finish(false);
  });

  it('declines uncertain plans and controls outside the task image', async () => {
    for (const plan of [null, { action: 'drag' as const, points: [{ x: 500, y: 30 }, { x: 800, y: 750 }] }]) {
      const h = await harness();
      vi.mocked(planRoyalMailVision).mockResolvedValueOnce(plan);
      await expect(h.solve(h.signal)).resolves.toBe(false);
      expect(h.mouse.down).not.toHaveBeenCalled();
      expect(h.submit.click).not.toHaveBeenCalled();
      h.finish(false);
    }
  });

  it.each(['pixels', 'prompt', 'frame', 'position'] as const)('rejects a changed %s generation after inference', async kind => {
    const h = await harness();
    vi.mocked(planRoyalMailVision).mockImplementationOnce(async () => {
      if (kind === 'pixels') h.state.image = await sharp({ create: { width: 200, height: 260, channels: 4, background: '#ffeeaa' } }).png().toBuffer();
      if (kind === 'prompt') h.state.signature = 'Replacement task';
      if (kind === 'frame') h.state.frameUrl += '-replacement';
      if (kind === 'position') h.state.x = 20;
      return { action: 'drag', points: [{ x: 300, y: 600 }, { x: 800, y: 750 }] };
    });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.mouse.down).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]?.outcome).toBe('stale');
  });

  it('discards a refreshed generation during snapshot metadata reads before inference', async () => {
    const h = await harness();
    const box = h.crop.boundingBox;
    h.crop.boundingBox = async () => { h.refresh(); return box(); };
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(planRoyalMailVision).not.toHaveBeenCalled();
    expect(h.mouse.down).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]?.outcome).toBe('stale');
  });

  it.each(['generation', 'frame'] as const)('rechecks the %s after awaiting input metadata', async kind => {
    const h = await harness();
    vi.mocked(planRoyalMailVision).mockImplementationOnce(async () => {
      const box = h.crop.boundingBox;
      h.crop.boundingBox = async () => {
        if (kind === 'generation') h.refresh();
        else h.state.frameUrl += '-replacement';
        return box();
      };
      return { action: 'drag', points: [{ x: 300, y: 600 }, { x: 800, y: 750 }] };
    });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.mouse.down).not.toHaveBeenCalled();
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]?.outcome).toBe('stale');
  });

  it('rejects a forged CAPTCHA origin before sending any image', async () => {
    const h = await harness();
    h.state.frameUrl = 'https://hcaptcha.com.evil.invalid/hcaptcha.html#frame=challenge&id=synthetic-widget';
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(planRoyalMailVision).not.toHaveBeenCalled();
    h.finish(false);
  });

  it('permits completion feedback after a drag applied to the matching image', async () => {
    const h = await harness();
    h.mouse.up.mockImplementationOnce(async () => {
      h.state.image = await sharp({ create: { width: 200, height: 260, channels: 4, background: '#55aa55' } }).png().toBuffer();
      h.state.submitLabel = 'Verify';
    });
    await expect(h.solve(h.signal)).resolves.toBe(true);
    expect(h.mouse.move).toHaveBeenCalledTimes(2);
    expect(h.submit.click).toHaveBeenCalledOnce();
    h.finish(true);
  });

  it('releases the pointer when a drag movement fails', async () => {
    const h = await harness();
    h.mouse.move.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('movement failed'); });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.mouse.up).toHaveBeenCalledOnce();
    expect(h.submit.click).not.toHaveBeenCalled();
    h.finish(false);
  });

  it('declines an unreadable task before spending the lookup\'s attempt when no other task is offered', async () => {
    const h = await harness();
    h.state.signature = 'Type the synthetic word';
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(planRoyalMailVision).not.toHaveBeenCalled();
    expect(h.mouse.down).not.toHaveBeenCalled();
    h.finish(false);
    // The retry's fresh context keeps the lookup's one attempt.
    expect(h.context.attempt).toEqual({ used: false, solving: false });
    expect(h.records).toEqual([expect.objectContaining({ outcome: 'unsupported', modelCalls: 0, refreshes: 0 })]);
  });

  it('exchanges an unreadable task for a drag task in the same widget and answers the new image', async () => {
    const h = await harness();
    Object.assign(h.state, { signature: 'Type the synthetic word', refreshable: true });
    await expect(h.solve(h.signal)).resolves.toBe(true);
    expect(h.refreshControl.click).toHaveBeenCalledOnce();
    expect(vi.mocked(planRoyalMailVision).mock.calls[0]?.[1]).toBe(h.state.image);
    expect(h.mouse.down).toHaveBeenCalledOnce();
    h.finish(true);
    expect(h.context.attempt).toMatchObject({ used: true, solving: true });
    expect(h.records[0]).toMatchObject({ outcome: 'accepted', refreshes: 1, modelCalls: 1, actions: 1, submissions: 1 });
  });

  it('refreshes at most three times and never past the lookup\'s plain cap', async () => {
    const h = await harness();
    Object.assign(h.state, { signature: 'Type the synthetic word', refreshable: true, refreshedSignature: 'Type the synthetic word' });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.refreshControl.click).toHaveBeenCalledTimes(3);
    h.finish(false);
    expect(h.records[0]).toMatchObject({ outcome: 'unsupported', refreshes: 3, modelCalls: 0 });
    expect(h.context.attempt).toEqual({ used: false, solving: false });
    const late = await harness();
    Object.assign(late.state, { signature: 'Type the synthetic word', refreshable: true });
    late.context.plainMs = () => 5_000;
    await expect(late.solve(late.signal)).resolves.toBe(false);
    expect(late.refreshControl.click).not.toHaveBeenCalled();
    late.finish(false);
  });

  it('answers a click task with native clicks inside the task image', async () => {
    const h = await harness();
    h.state.signature = 'Please click each synthetic object';
    vi.mocked(planRoyalMailVision).mockResolvedValueOnce({ action: 'click', points: [{ x: 200, y: 600 }, { x: 700, y: 700 }] });
    await expect(h.solve(h.signal)).resolves.toBe(true);
    expect(h.mouse.click).toHaveBeenCalledTimes(2);
    expect(h.mouse.click).toHaveBeenNthCalledWith(1, 40, 156);
    expect(h.mouse.down).not.toHaveBeenCalled();
    expect(h.submit.click).toHaveBeenCalledOnce();
    h.finish(true);
    expect(h.records[0]).toMatchObject({ outcome: 'accepted', modelCalls: 1, actions: 2, submissions: 1 });
  });

  it('declines a plan whose action differs from the task\'s prompt', async () => {
    const h = await harness();
    h.state.signature = 'Please click each synthetic object';
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.mouse.click).not.toHaveBeenCalled();
    expect(h.mouse.down).not.toHaveBeenCalled();
    h.finish(false);
    expect(h.records[0]).toMatchObject({ outcome: 'declined', modelCalls: 1 });
  });

  it('advances one answered click page with Next and reads the second page afresh', async () => {
    const h = await harness();
    Object.assign(h.state, { signature: 'Please click each synthetic object', afterAnswer: 'Next' });
    const first = h.state.image;
    vi.mocked(planRoyalMailVision)
      .mockResolvedValueOnce({ action: 'click', points: [{ x: 200, y: 600 }] })
      .mockResolvedValueOnce({ action: 'click', points: [{ x: 500, y: 500 }, { x: 800, y: 800 }] });
    await expect(h.solve(h.signal)).resolves.toBe(true);
    const images = vi.mocked(planRoyalMailVision).mock.calls.map(call => call[1]);
    expect(images).toHaveLength(2);
    expect(images[0]).toBe(first);
    expect(images[1]).not.toBe(first);
    expect(h.mouse.click).toHaveBeenCalledTimes(3);
    expect(h.submit.click).toHaveBeenCalledTimes(2);
    h.finish(true);
    expect(h.records[0]).toMatchObject({ outcome: 'accepted', modelCalls: 2, rounds: 2, actions: 3, submissions: 1 });
  });

  it('does not advance to a third page', async () => {
    const h = await harness();
    Object.assign(h.state, { signature: 'Please click each synthetic object', afterAnswer: 'Next', nextAfterAnswer: 'Next' });
    vi.mocked(planRoyalMailVision).mockResolvedValue({ action: 'click', points: [{ x: 200, y: 600 }] });
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.submit.click).toHaveBeenCalledOnce();
    h.finish(false);
    expect(h.records[0]).toMatchObject({ outcome: 'unsupported', modelCalls: 2, actions: 2, submissions: 0 });
    expect(h.context.attempt).toEqual({ used: true, solving: false });
  });

  it('spends the lookup\'s one model request even when the model declines', async () => {
    const h = await harness();
    vi.mocked(planRoyalMailVision).mockResolvedValueOnce(null);
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(h.context.attempt.used).toBe(true);
    h.finish(false);
  });

  it('does not let a telemetry sink failure change accepted retrieval', async () => {
    const h = await harness();
    h.context.options.onVerification = () => { throw new Error('sink failed'); };
    await expect(h.solve(h.signal)).resolves.toBe(true);
    expect(() => h.finish(true)).not.toThrow();
  });

  it.each([[200, 'captcha_refused'], [429, 'captcha_blocked'], [403, 'captcha_blocked']] as const)(
    'stops after a bound verification refusal HTTP %s', async (status, reason) => {
      const h = await harness();
      h.submit.click.mockImplementationOnce(async () => { h.state.submitted = true; h.refusal(status); });
      await expect(h.solve(h.signal)).rejects.toMatchObject({ kind: 'challenge', reason });
      expect(planRoyalMailVision).toHaveBeenCalledOnce();
      expect(h.submit.click).toHaveBeenCalledOnce();
      h.finish(false);
    });

  it('honors caller cancellation while inference is pending', async () => {
    const h = await harness();
    const reason = new Error('cancelled');
    vi.mocked(planRoyalMailVision).mockImplementationOnce(async () => { h.controller.abort(reason); throw reason; });
    await expect(h.solve(h.signal)).rejects.toBe(reason);
    expect(h.mouse.down).not.toHaveBeenCalled();
    h.finish(false);
  });

  it('starts no model request when the history and cleanup reserve is already spent', async () => {
    const h = await harness();
    h.spendBudget();
    await expect(h.solve(h.signal)).resolves.toBe(false);
    expect(planRoyalMailVision).not.toHaveBeenCalled();
    h.finish(false);
  });
});

describe('coordinate guide', () => {
  it('builds a bounded coordinate guide independently of the live widget', () => {
    const grid = Buffer.from(royalMailVisionGrid(500, 600)).toString('utf8');
    expect(grid).toContain('width="500" height="600"');
    expect(grid).toContain('>100</text>');
    expect(grid).toContain('>900</text>');
    expect(() => royalMailVisionGrid(0, 600)).toThrow(RangeError);
    expect(() => royalMailVisionGrid(500, 600.5)).toThrow(RangeError);
    expect(() => royalMailVisionGrid(500, 1201)).toThrow(RangeError);
  });

});
