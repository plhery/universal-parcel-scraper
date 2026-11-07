// Synthetic slip, facilities, contact data and runtime detail state; no live shipment data.
export const NUMBER = '1234567890';
const HEADERS = ['伝票番号', '指定日', 'お届け予定', '日付', '時間', '状況', '個数', '営業所', '車号', '作業員'];
const ABSENT = 'お問い合わせの伝票番号は登録されておりません。恐れ入りますが、発送取扱い店へお問い合わせください。';
export interface FixtureScan { day: string; clock: string; wording: string; location?: string }
export const SUMMARY_SCANS: FixtureScan[] = [
  { day: '12/31', clock: '23:50', wording: '受付', location: 'Example receipt terminal' },
  { day: '01/01', clock: '00:11', wording: '指定場所置き', location: 'Example delivery terminal' },
];
export const DETAIL_SCANS: FixtureScan[] = [
  SUMMARY_SCANS[0]!,
  { day: '12/31', clock: '23:59', wording: '運行', location: 'Example transit terminal' },
  { day: '01/01', clock: '00:10', wording: '指定場所置き', location: 'Example delivery terminal' },
];

export function fixture(view: 'summary' | 'detail' = 'summary', options: {
  number?: string; scans?: FixtureScan[]; missing?: boolean; detail?: boolean; capability?: string; designated?: string;
} = {}): string {
  const number = (options.number ?? NUMBER).padStart(15, '0');
  const scans = options.scans ?? (view === 'summary' ? SUMMARY_SCANS : DETAIL_SCANS);
  const span = options.missing ? 2 : scans.length;
  const cell = (label: string, value: string, attrs = '') => `<td class="rhead visible-xs">${label}</td><td class="rbody" ${attrs}>${value}</td>`;
  const link = view === 'summary' && options.detail !== false && !options.missing
    ? `<br><a href="javascript:void(0)" onclick="nahs0030find('${number}','000001','${options.capability ?? 'SYNTHETICCAP'}')"><span class="glyphicon glyphicon-info-sign" aria-hidden="true"></span>詳細</a>` : '';
  const head = `<td class="head" rowspan="${span}">${number}${link}</td>`;
  const rows = options.missing ? `<tr>${head}<td class="rbodyFull" rowspan="2" colspan="10">${ABSENT}</td></tr><tr></tr>`
    : scans.map((scan, index) => `<tr>${index === 0 ? head + cell('指定日', options.designated ?? '', `rowspan="${span}"`) + cell('お届け予定', '', `rowspan="${span}"`) : ''}${
      cell('日付', scan.day) + cell('時間', scan.clock) + cell('状況', scan.wording) + cell('個数', '1')
      + cell('営業所名', scan.location ?? 'Example terminal') + cell('営業所TEL', 'SYNTHETIC_PHONE')
      + cell('車号', 'SYNTHETIC_VEHICLE') + cell('作業員', 'SYNTHETIC_STAFF')
    }</tr>`).join('');
  return `<html><head><meta charset="utf-8"><title>セイノースーパーエクスプレス お届け状況確認</title></head><body>
    <h1>伝票番号によるお届け状況確認${view === 'detail' ? '（詳細画面）' : ''}</h1>
    <form name="main" method="post" action="Main.jsp">
      <input type="hidden" name="uji.verbs" value=""><input type="hidden" name="uji.bean" value="">
      <input type="hidden" name="strDenpyoNo" value="${view === 'detail' ? number : ''}">
      <input type="hidden" name="strSyukaTenCD" value="${view === 'detail' ? '000001' : ''}">
      <input type="hidden" name="strNinsyoNo" value="${view === 'detail' ? 'SYNTHETICCAP' : ''}">
      <input type="hidden" name="strFrontGamen" value="NAHS0010">
      <table class="table-typeB col-xs-12"><tbody><tr>${HEADERS.map(h => `<th>${h}</th>`).join('')}</tr>${rows}</tbody></table>
    </form></body></html>`;
}
