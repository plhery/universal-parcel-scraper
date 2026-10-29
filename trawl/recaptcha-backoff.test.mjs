import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecaptchaAudioBackoff } from './recaptcha-backoff.mjs';

test('a block suppresses audio for six hours without extending the wait on another observation', () => {
  let now = 1000;
  const backoff = createRecaptchaAudioBackoff(() => now);
  assert.equal(backoff.remainingMs(), 0);
  backoff.block();
  now += 60_000;
  backoff.block();
  assert.equal(backoff.remainingMs(), 6 * 60 * 60 * 1000 - 60_000);
  now += 6 * 60 * 60 * 1000 - 60_000;
  assert.equal(backoff.remainingMs(), 0);
  backoff.block();
  assert.equal(backoff.remainingMs(), 6 * 60 * 60 * 1000);
});
