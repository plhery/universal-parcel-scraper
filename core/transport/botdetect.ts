import { createHash } from 'node:crypto';

/** One BotDetect captcha instance, from the hidden fields its form carries. */
export interface BotDetectInstance {
  /** The instance id that names its picture, its sound and its answer. */
  id: string;
  /**
   * The SHA-1 of a counter and the id, which the form's script searches for from `start` upward.
   * The counter sets the case of each character the user types. Absent on a form without it.
   */
  hash?: string;
  start?: number;
}

const CAPTCHA_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// The script searches up to 2^31 - 1; forms seen place the counter within about 125,000 of its start.
const MAX_COUNTERS = 1 << 20;
const SLICE = 16_384;

function hiddenValue(html: string, name: string): string | null {
  for (const [tag] of html.matchAll(/<input\b[^>]{0,400}>/gi)) {
    if (tag.includes(`name="${name}"`)) return /\bvalue="([^"]{0,80})"/.exec(tag)?.[1] ?? null;
  }
  return null;
}

/** The captcha instance a page's form carries for the captcha named `captcha`, or null when it has none. */
export function botDetectInstance(html: string, captcha: string): BotDetectInstance | null {
  if (!CAPTCHA_ID.test(captcha)) throw new TypeError('BotDetect captcha names are letters, digits and underscores');
  const id = hiddenValue(html, `BDC_VCID_${captcha}`);
  if (!id || !/^[0-9a-f]{32}$/.test(id)) return null;
  const hash = hiddenValue(html, `BDC_Hs_${captcha}`);
  const start = hiddenValue(html, `BDC_SP_${captcha}`);
  return hash && start && /^[0-9a-f]{40}$/.test(hash) && /^\d{1,10}$/.test(start) ? { id, hash, start: Number(start) } : { id };
}

/** The characters' cases the counter sets: its remainder by 65533 plus one in binary, read from the right. */
export function botDetectCase(code: string, counter: number): string {
  const mask = ((counter % 65533) + 1).toString(2);
  let answer = '';
  for (let index = code.length - 1, bit = mask.length - 1; index >= 0; index--, bit--) {
    answer = (mask[bit] === '1' ? code[index]!.toUpperCase() : code[index]!.toLowerCase()) + answer;
  }
  return answer;
}

/**
 * The picture's code as the form's script would send it, its characters' cases set by the
 * instance's counter; the code itself on a form without one, and null when no counter matches.
 */
export async function botDetectAnswer(code: string, instance: BotDetectInstance, signal?: AbortSignal): Promise<string | null> {
  if (instance.hash === undefined || instance.start === undefined) return code;
  const end = Math.min(instance.start + MAX_COUNTERS, 2 ** 31);
  for (let counter = instance.start; counter < end; counter++) {
    if (createHash('sha1').update(`${counter}${instance.id}`).digest('hex') === instance.hash) return botDetectCase(code, counter);
    // The search takes a few hundred milliseconds; it lets other work and cancellation in.
    if ((counter - instance.start) % SLICE === SLICE - 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  return null;
}
