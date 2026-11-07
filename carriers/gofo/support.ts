// GOFO appends its support phone and email to some scans, in English or
// Spanish; the public page removes that line before display.
const CONTACT = String.raw`(?:\+?\(?\d[\d ().-]*\d|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)`;
const SUPPORT_LINE = new RegExp(String.raw`\s*(?:For delivery issues (?:&|and) tracking support, contact GOFO at|Para problemas de entrega y soporte de seguimiento, comun[ií]quese con GOFO al) ${CONTACT}(?:,? (?:or|and|o|y) ${CONTACT})*\.?$`, 'iu');

/** A GOFO scan's wording without its trailing support line; a scan worded only by that line keeps it. */
export function withoutGofoSupportLine(text: string): string {
  return text.replace(SUPPORT_LINE, '') || text;
}
