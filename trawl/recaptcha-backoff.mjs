// Google judges the service's address, shared by all browser contexts and
// solver copies. Store no challenges or responses, only the next audio time.
const BLOCK_MS = 6 * 60 * 60 * 1000;

export function createRecaptchaAudioBackoff(now = Date.now) {
  let until = 0;
  return {
    remainingMs: () => Math.max(0, until - now()),
    block: () => {
      const time = now();
      // A concurrent observation or skipped lookup must not prolong the wait.
      if (until <= time) until = time + BLOCK_MS;
    },
  };
}

export const recaptchaAudioBackoff = createRecaptchaAudioBackoff();
