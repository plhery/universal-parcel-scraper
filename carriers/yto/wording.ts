// The website's expanded description, which 17TRACK relays in place of the short label: the
// scan's own clause, then who collected or delivers the parcel with their phone,
// "揽收人: <name>（<phone>）", and YTO's hotline in brackets, "【物流问题请致电（专属热线:<number>）更快解决】".
// A clause or bracket that gives a courier, a signer, a phone, a hotline or a complaint line, as
// relayed Chinese post scans are read.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|呼叫|姓名|司机|(?:揽收|揽件|揽投|收件|取件|派件|派送|收派|配送|投递|签收|快递|业务)[人员]|(?<![A-Z\d])\d{5,}/i;

/**
 * A YTO scan's expanded description without the courier's name and phone and
 * YTO's hotline, as the adapter keeps neither: its clauses up to the first that
 * names a contact, without a bracket that gives one. Empty when the first does.
 */
export function ytoRelayedWording(description: string): string {
  const text = description.replace(/【([^【】]*)】/gu, (whole, inner: string) => (CONTACT.test(inner) ? '' : whole));
  const kept: string[] = [];
  for (const clause of text.split(/(?<=[，,。；;！!？?])/u)) {
    if (CONTACT.test(clause)) break;
    kept.push(clause);
  }
  return kept.join('').replace(/\s+/gu, ' ').trim().replace(/[\s,，;；:：]+$/u, '');
}

/**
 * The place a transit scan's description names first, "您的快件已经到达【<place>】…" or
 * "您的快件离开【<place>】，已发往【…】", for a scan the feed sends without its place.
 */
export function ytoDescribedPlace(description: string): string | undefined {
  const place = /^您的快件(?:已经)?(?:到达|离开)【([^【】]{1,100})】/u.exec(description.trim())?.[1]?.trim();
  return place && !CONTACT.test(place) ? place : undefined;
}
