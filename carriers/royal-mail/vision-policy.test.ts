import { describe, expect, it } from 'vitest';
import { royalMailVisionButton, royalMailVisionCanAdvance, royalMailVisionTask } from './vision-policy.js';

describe('Royal Mail verification controls', () => {
  it.each([
    ['Please drag the synthetic piece to complete the image', 'drag'], ['Move the synthetic object onto its shadow', 'drag'],
    ['Please click each synthetic object', 'click'], ['Select the synthetic animal', 'click'], ['Tap on the synthetic shape', 'click'],
    ['Type the synthetic word', null], ['x'.repeat(1001) + ' click', null],
  ] as const)('reads the task in %s', (prompt, wanted) => {
    expect(royalMailVisionTask(prompt)).toBe(wanted);
  });

  it.each([
    ['Verify', 'Next', 'ambiguous'], ['Next', 'Verify', 'ambiguous'], ['Skip', 'Verify', 'ambiguous'],
    [null, 'Next', 'next'], ['Verify', 'Verify', 'verify'], [null, 'Skip', 'skip'], ['unknown', 'Verify', 'ambiguous'],
    ['Submit Answers', 'Next', 'next'], ['Submit Answers', 'Verify', 'verify'],
    ['Next Challenge, page 1 of 2', 'Next', 'next'], ['Next Challenge, page 1 of 2', 'Verify', 'ambiguous'],
  ] as const)('classifies %s / %s without treating Next as Verify', (aria, text, wanted) => {
    expect(royalMailVisionButton(aria, text)).toBe(wanted);
  });

  it.each(['unknown', 'Next Challenge, page 1 of 2', 'Verify'])('uses initial visible Skip only for readiness with %s', aria => {
    expect(royalMailVisionButton(aria, 'Skip', true)).toBe('skip');
    expect(royalMailVisionButton(aria, 'Skip')).toBe('ambiguous');
  });

  it('allows only one answered click transition while verification remains idle', () => {
    expect(royalMailVisionCanAdvance(0, 'click', 0, 2, false, false, false, false)).toBe(true);
    for (const [page, action, nexts, clicks, checking, refused, blocked, aborted] of [
      [1, 'click', 0, 2, false, false, false, false], [0, 'drag', 0, 2, false, false, false, false],
      [0, 'click', 1, 2, false, false, false, false], [0, 'click', 0, 0, false, false, false, false],
      [0, 'click', 0, 13, false, false, false, false], [0, 'click', 0, 2, true, false, false, false],
      [0, 'click', 0, 2, false, true, false, false], [0, 'click', 0, 2, false, false, true, false],
      [0, 'click', 0, 2, false, false, false, true],
    ] as const) expect(royalMailVisionCanAdvance(page, action, nexts, clicks, checking, refused, blocked, aborted)).toBe(false);
  });
});
