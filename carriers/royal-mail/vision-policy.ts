/** What the task's prompt asks for: one drag, or clicks on its targets. */
export function royalMailVisionTask(prompt: string): 'drag' | 'click' | null {
  if (prompt.length > 1000) return null;
  return /\b(?:drag|move)\b/i.test(prompt) ? 'drag' : /\b(?:click|select|tap)\b/i.test(prompt) ? 'click' : null;
}

type ButtonKind = 'verify' | 'next' | 'skip' | 'empty' | 'ambiguous';

/** Initial Skip means ready for answers; it never authorizes a submission. */
export function royalMailVisionButton(aria: string | null, text: string, initial = false): ButtonKind {
  const kind = (value: string | null) => {
    const label = (value ?? '').trim();
    return !label ? 'empty' : /^Verify(?: (?:Answers|Challenge))?$/i.test(label) ? 'verify'
      : /^Next(?: Challenge)?(?:,? page [1-9] of [1-9])?$/i.test(label) ? 'next'
        : /^Skip(?: Challenge)?$/i.test(label) ? 'skip' : 'other';
  };
  const accessible = kind(aria), visible = kind(text);
  if (initial && visible === 'skip') return 'skip';
  if (/^Submit(?: (?:Answers?|Challenge))?$/i.test((aria ?? '').trim()) && ['skip', 'next', 'verify'].includes(visible)) {
    return visible as 'skip' | 'next' | 'verify';
  }
  if (accessible === 'other' || visible === 'other' || accessible !== 'empty' && visible !== 'empty' && accessible !== visible) return 'ambiguous';
  return visible === 'empty' ? accessible : visible;
}

/** Only the first answered click page can advance; a third page stays unsupported. */
export function royalMailVisionCanAdvance(page: number, action: 'click' | 'drag', nexts: number, clicks: number,
  checking: boolean, refused: boolean, blocked: boolean, aborted: boolean): boolean {
  return !aborted && !checking && !refused && !blocked && page === 0 && action === 'click' && nexts === 0 && clicks > 0 && clicks <= 12;
}
