// An e-mail address, masked in part or not ("j***n@example.com"), even when the next field's digits follow it unspaced.
const ADDRESS = String.raw`[A-Za-z0-9._%+*-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`;
// One in brackets goes with them: "(…)", "<…>".
const ENCLOSED = new RegExp(String.raw`\s*(?:\(\s*${ADDRESS}\s*\)|<\s*${ADDRESS}\s*>|\[\s*${ADDRESS}\s*\]|（\s*${ADDRESS}\s*）)`, 'g');
const NAMED = new RegExp(ADDRESS, 'g');
const CUT = '\u0000';
// What introduces an address, or joins it to another way of reaching someone, goes with it: "sent to: …",
// "contact us at +1 … or …", "e-mail: …", and "at or …" where a template left the phone out.
const BEFORE = new RegExp(String.raw`(?:\s*\b(?:or|and|at|to|via|by)\b|\s*(?:e-?mail|邮箱|电子邮件|邮件地址)(?=\s*[:：]))?(?:\s*[:：])?\s*${CUT}`, 'giu');
const AFTER = new RegExp(String.raw`${CUT}\s*\b(?:or|and)\b`, 'gi');

/**
 * Words without an e-mail address they name, the recipient's or a depot's, and the words that only
 * introduce it. Scan words reach whoever a parcel's history is shown to, and an address in them says
 * nothing about the parcel.
 */
export function withoutEmail(text: string): string {
  if (!text.includes('@') || text.includes(CUT)) return text;
  const marked = text.replace(ENCLOSED, '').replace(NAMED, CUT);
  if (marked === text) return text;
  let cut = marked;
  for (let pass = 0; pass < 3; pass++) {
    const next = cut.replace(BEFORE, CUT);
    if (next === cut) break;
    cut = next;
  }
  return cut.replace(AFTER, CUT).replaceAll(CUT, ' ')
    .replace(/\s+([,.;:!?，。；：])/g, '$1').replace(/\s+/g, ' ').replace(/^[\s,;:，；：]+|[\s,;:，；：]+$/g, '').trim();
}

/** Whether the words name an e-mail address `withoutEmail` drops. */
export function namesEmail(text: string): boolean {
  return withoutEmail(text) !== text;
}
