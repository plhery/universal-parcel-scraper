/**
 * ZTO's scan sentences as a forwarder's tracker copies them once it has handed a parcel to ZTO: the
 * city in brackets first, then ZTO's sentence, which names the courier with a mobile, the branch's and
 * the complaint line's numbers and the pickup point, and ends on a courtesy. ZTO's own adapter reads
 * its codes instead; this serves the forwarders that relay the text.
 */
import { clean } from '../../core/transport/text.js';

/** A relayed sentence without the people, phones, pickup point and courtesy it names, and the city it opens with. */
export interface RelayedZtoText {
  readonly description: string;
  readonly city?: string;
}

// A phone: a mobile, a landline with its area code, a hotline.
const PHONE = /(?<![\d-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\d-])/u;
// Words that give a contact, an address or a person.
const CONTACT = new RegExp(`电话|手机|致电|联系|电联|热线|投诉|呼叫|姓名|地址|签收人|代收人|收件人|收货人|${PHONE.source}`, 'u');
// The courtesy a row ends on: nothing after it is the parcel's.
const AFTERWORD = /^(?:如有|如遇|如需|若有|关注|感谢|猜您|可更直接|无需找|获取实时)/u;
// Who collected the parcel, with a phone: "由<branch><name>（<mobile>）".
const COLLECTED_BY = /由[^\s，,。；;：:（()）【】]{1,30}[（(]\s*(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})\s*[)）]/gu;
// A name before a mobile in brackets, after a branch, a bracket or a space: "…分部（<landline>）<name>（<mobile>）".
const NAMED = /(?<=^|[\s）)】]|[部点站司厅心])\p{Script=Han}{2,4}[（(]\s*1[3-9]\d{9}\s*[)）]/gu;
// A role and the person in brackets after it: "快递员【<name>,<mobile>】", "业务员【<branch>-<name>】".
const ROLE_BRACKET = /(快递员|业务员|派件员|派送员|揽收员|揽件员|收派员|配送员|快递小哥)\s*[：:]?\s*【[^【】]*】/gu;
// A pickup point in brackets, which can name the recipient's building, with the 的 before it: "丰巢 的【…柜】".
const PICKUP_POINT = /(?:\s*的)?\s*【[^【】]*(?:驿站|丰巢|快递柜|智能柜|代收点|自提|超市|柜)[^【】]*】/gu;
const BRACKETED = /【[^【】]*】/gu;
const PARENTHESIZED = /[（(][^（）()]*[)）]/gu;
// ZTO's city before its sentence: "【西安市】 ".
const CITY = /^【(\p{Script=Han}{2,10}[市县区州盟])】\s*/u;
const CLAUSE_END = /(?<=[，,。；;！!？?])/u;
const PUNCTUATION = /[，,。；;！!？?\s]/gu;

/**
 * A relayed ZTO sentence without the courier's or a signatory's name, any phone, the pickup point or the
 * courtesy, and the city its brackets open with: "【沈阳市】沈阳长白二部 的业务员【<name>,<mobile>】正在为您派件（…）"
 * reads "沈阳长白二部 的业务员正在为您派件" in 沈阳市. A clause that still gives a contact is left out.
 */
export function relayedZtoText(raw: string): RelayedZtoText {
  let text = clean(raw, 2000);
  const city = CITY.exec(text);
  if (city) text = text.slice(city[0].length);
  text = text.replace(COLLECTED_BY, '').replace(NAMED, '').replace(ROLE_BRACKET, '$1').replace(PICKUP_POINT, '')
    .replace(BRACKETED, (part) => (CONTACT.test(part) ? '' : part))
    .replace(PARENTHESIZED, (part) => (CONTACT.test(part) || AFTERWORD.test(part.slice(1)) ? '' : part));
  const kept: string[] = [];
  for (const clause of text.split(CLAUSE_END)) {
    const words = clause.trim();
    if (AFTERWORD.test(words)) break;
    if (words.replace(PUNCTUATION, '') && !CONTACT.test(words)) kept.push(words);
  }
  const description = clean(kept.join(''), 300).replace(/[，,。；;：:！!？?\s]+$/u, '');
  return { description, ...(city ? { city: city[1]! } : {}) };
}
