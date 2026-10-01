import { afterEach, expect, it, vi } from 'vitest';
import { amazonShippingEligibility } from './eligibility.js';
import { AmazonShippingTracker, AmazonShippingHistoryExpiredError, AmazonShippingNotFoundError } from './adapter.js';

afterEach(() => vi.restoreAllMocks());

it('distinguishes a missing parcel from expired history through stable error reasons', async () => {
  const fetch = vi.spyOn(AmazonShippingTracker.prototype, 'fetch');
  fetch.mockResolvedValueOnce({ status: 'in_transit' })
    .mockRejectedValueOnce(new AmazonShippingHistoryExpiredError())
    .mockRejectedValueOnce(new AmazonShippingNotFoundError())
    .mockRejectedValueOnce(new Error('Transport failed'));
  await expect(amazonShippingEligibility('FR0000000001')).resolves.toBe('available');
  await expect(amazonShippingEligibility('FR0000000001')).resolves.toBe('expired');
  await expect(amazonShippingEligibility('FR0000000001')).resolves.toBe('not-found');
  await expect(amazonShippingEligibility('FR0000000001')).rejects.toThrow('Transport failed');
  expect(new AmazonShippingHistoryExpiredError()).toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  expect(new AmazonShippingNotFoundError()).toMatchObject({ kind: 'not_found', reason: 'shipment_not_found' });
});
