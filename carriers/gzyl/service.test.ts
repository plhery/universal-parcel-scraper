import { describe, expect, it } from 'vitest';
import { hualeiServiceName } from './service.js';

describe('hualeiServiceName', () => {
  it("gives a tenant's product name in English", () => {
    expect([
      '欧洲DHL快线-A', '欧洲DHL慢线-A', '欧洲DHL带电-A', '欧洲联邦FedEx-带电-A', '欧洲卡航-A', '美国空派-F大货-A',
      '墨西哥专线-特敏-A', 'YL全球通PD', 'MTS全球小包', 'KK轨迹定制版A', '欧美服装专线小包-F(包税)HYYT', '欧美标准专线(普+特)-Example',
    ].map(hualeiServiceName)).toEqual([
      'Europe DHL Express Line-A', 'Europe DHL Economy Line-A', 'Europe DHL Battery-A', 'Europe FedEx-Battery-A', 'Europe Road Freight-A',
      'US Air Freight-F Bulk Cargo-A', 'Mexico Line-Sensitive-A', 'YL Global PD', 'MTS Global Small Parcel', 'KK Custom Tracking A',
      'Europe and US Apparel Line Small Parcel-F(Duties Paid)HYYT', 'Europe and US Standard Line(General+Special)-Example',
    ]);
  });

  it('keeps a name it cannot translate whole, and one with no Chinese, as written', () => {
    expect(hualeiServiceName('欧洲合成专线-A')).toBe('欧洲合成专线-A');
    expect(hualeiServiceName('Synthetic Line PD')).toBe('Synthetic Line PD');
  });
});
