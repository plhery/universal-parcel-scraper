/** Operational text before the postal feed's labelled recipient and dispatch metadata. */
export function honducorWording(value: string): string {
  return value.replace(/[,，]\s*(?:簽收人姓名|签收人姓名|寄達國|原寄國|課稅與否|本件將轉往|出口局|總包號碼|清單號碼|預計離開原寄國日期)\s*[:：][\s\S]*$/u, '')
    .replace(/[,，]\s*$/u, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}
