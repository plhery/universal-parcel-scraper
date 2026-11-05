/**
 * A Hualei tenant's product name (`productKindName`) in English. Tenants name their lines in
 * Chinese around Latin codes: "欧洲DHL快线-A" is the Europe DHL express line, tier A. Each term
 * below is replaced, the longest first; a name with a term the table does not know is kept as
 * written, never shown half translated.
 */
const TERMS: ReadonlyArray<readonly [RegExp, string]> = ([
  // Places a line serves.
  ['欧美', 'Europe and US'], ['欧洲', 'Europe'], ['全球通', 'Global'], ['全球', 'Global'], ['美国', 'US'], ['英国', 'UK'],
  ['西班牙', 'Spain'], ['波兰', 'Poland'], ['墨西哥', 'Mexico'], ['荷兰', 'Netherlands'],
  // How it travels: a dedicated line, a fast or an economy one, a small parcel, air freight, bulk cargo
  // and road freight run on a timetable (卡航, "truck flights").
  ['专线', 'Line'], ['快线', 'Express Line'], ['慢线', 'Economy Line'], ['小包', 'Small Parcel'], ['空派', 'Air Freight'],
  ['大货', 'Bulk Cargo'], ['卡航', 'Road Freight'], ['邮政', 'Post'],
  // What it carries and how it is priced: batteries, sensitive or special goods, general goods,
  // apparel, a saver or standard tier and duties paid.
  ['带电', 'Battery'], ['特敏', 'Sensitive'], ['敏感', 'Sensitive'], ['特货', 'Special Goods'], ['特惠', 'Saver'],
  ['服装', 'Apparel'], ['标准', 'Standard'], ['包税', 'Duties Paid'], ['普', 'General'], ['特', 'Special'],
  // The platform's custom track product (轨迹定制), as a tenant names a line on it.
  ['轨迹定制版', 'Custom Tracking'], ['轨迹定制', 'Custom Tracking'],
] as const).map(([term, english]) => [new RegExp(term, 'gu'), english] as const)
  .sort(([left], [right]) => right.source.length - left.source.length);

// FedEx's Chinese name is 联邦快递: 联邦 ("federal") before its Latin name says it again.
const FEDEX_PREFIX = /联邦(?=fedex)/giu;

/** The product name in English, or as written when it holds Chinese the table does not know. */
export function hualeiServiceName(product: string): string {
  if (!/\p{Script=Han}/u.test(product)) return product;
  let english = product.replace(FEDEX_PREFIX, '');
  for (const [term, word] of TERMS) english = english.replace(term, ` ${word} `);
  if (/\p{Script=Han}/u.test(english)) return product;
  return english.replace(/\s+/g, ' ').replace(/\s*([-+()（）])\s*/gu, '$1').trim();
}
