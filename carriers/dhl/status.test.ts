import { expect, it } from 'vitest';
import { stageForText } from './status.js';

it('keeps a negation across a German ordinal date', () => {
  expect(stageForText('Die Sendung wurde nicht am 4. November zugestellt.')).toBe('failed_attempt');
});
