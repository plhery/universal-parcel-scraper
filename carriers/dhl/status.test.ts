import { expect, it } from 'vitest';
import { stageForText } from './status.js';

it('keeps a negation across a German ordinal date', () => {
  expect(stageForText('Die Sendung wurde nicht am 4. November zugestellt.')).toBe('failed_attempt');
});

it('keeps a conditional return pending collection', () => {
  expect(stageForText('Wenn die Sendung nicht abgeholt wird, wird sie an den Absender zurückgesandt.')).toBe('ready_for_pickup');
});

it('reads a pickup forecast for the next business day as a forecast, and the outlet\'s own notice as ready for pickup', () => {
  expect(stageForText('Ready for pickup next business day', 'failed_attempt')).toBe('failed_attempt');
  expect(stageForText('Ready for pickup next business day', '')).toBe('');
  expect(stageForText('The shipment is available for pick-up from the retail outlet as of now.')).toBe('ready_for_pickup');
  expect(stageForText('Ready for pickup')).toBe('ready_for_pickup');
});

it('reads a parcel soon ready at the outlet as on its way there, not ready for pickup', () => {
  expect(stageForText('In Kürze in Filiale abholbereit')).toBe('in_transit');
  expect(stageForText('Available for pickup shortly')).toBe('in_transit');
  expect(stageForText('Sendung liegt in der Filiale zur Abholung bereit')).toBe('ready_for_pickup');
});
