import { expect, it } from 'vitest';
import { stageForText } from './status.js';

it('keeps a negation across a German ordinal date', () => {
  expect(stageForText('Die Sendung wurde nicht am 4. November zugestellt.')).toBe('failed_attempt');
});

it('keeps a conditional return pending collection', () => {
  expect(stageForText('Wenn die Sendung nicht abgeholt wird, wird sie an den Absender zurückgesandt.')).toBe('ready_for_pickup');
});
