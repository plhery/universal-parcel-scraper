/** Small text helpers every adapter needs when projecting provider payloads. */

/** Collapse whitespace, trim, and cap the length of a provider string; non-strings become ''. */
export function clean(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

/** Like `clean`, for values that may arrive as numbers (ids, codes). */
export function cleanScalar(value: unknown, maxLength = 500): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : clean(value, maxLength);
}

// UTF-8 bytes read one by one as Latin-1: a lead byte, then one to three continuation bytes ("KÃ¶ln" for "Köln").
const MISREAD_UTF8 = /[Â-ô][\u0080-¿]{1,3}/g;

/**
 * Text whose UTF-8 was read as Latin-1 somewhere upstream, put right; anything else, such as a
 * Latin-1 letter before an ordinary one, stays as it is.
 */
export function repairMisreadUtf8(value: string): string {
  return value.replace(MISREAD_UTF8, (run) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(run, (char) => char.charCodeAt(0)));
    } catch {
      return run;
    }
  });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip tags from an HTML fragment and collapse whitespace; for short provider strings only. */
export function textFromHtml(value: unknown, maxLength = 500): string {
  return typeof value === 'string'
    ? clean(value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'), maxLength)
    : '';
}
