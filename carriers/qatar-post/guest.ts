import { createCipheriv } from 'node:crypto';

// Shared guest configuration shipped identically in the official public Android app.
const STATIC_KEY = "6GJJHYI987YGFRESJ"; // gitleaks:allow
const KEY = "abcdefghijklmnopqrstuvwxzy012345"; // gitleaks:allow
const IV = "a1b2c3d4e5f60789"; // gitleaks:allow

export function qatarGuestTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid guest timestamp');
  const pad = (value: number) => String(value).padStart(2, '0');
  return [pad(now.getUTCMinutes()), now.getUTCFullYear(), pad(now.getUTCSeconds()), pad(now.getUTCDate()),
    pad(now.getUTCMonth() + 1), pad(now.getUTCHours())].join('|');
}

/** Mint per request, including a network retry; the app uses its payment-named AES pair for this guest header. */
export function qatarGuestToken(now = new Date()): string {
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(KEY, 'utf8'), Buffer.from(IV, 'utf8'));
  const plain = JSON.stringify({ ExpireDateString: qatarGuestTimestamp(now), StaticKey: STATIC_KEY });
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}
