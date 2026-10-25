import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { checksumRejections, detectCarrierMatch, parseTrackingInput } from './index.js';

describe('prefixed Asian shipment references and shared numeric formats', () => {
  it('selects the documented SF waybill family without widening bare numeric attribution', () => {
    expect(detectCarrierMatch('sf 000 000 000 0000')).toMatchObject({ carrier: 'sf-express', confidence: 'high' });
    expect(parseTrackingInput('Tracking number: SF0000000000000')).toMatchObject({
      trackingNumber: 'SF0000000000000', carrier: 'sf-express', confidence: 'high',
    });
    expect(detectCarrierMatch('SF0000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['sf-express'] });
    expect(detectCarrierMatch('000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    for (const number of ['SF000000000001', 'SF00000000000001', 'XSF0000000000001', 'SF0000000000001CN']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('sf-express');
    }
  });

  it('selects JD Logistics for its prefixed domestic waybills at their own length only', () => {
    for (const number of ['JD0000000000000', 'JDV000000000000', 'JDVA00000000000', 'jdx 000000000000']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'jd-logistics', confidence: 'high' });
    }
    for (const number of ['JD000000000000', 'JD00000000000000', 'JDVAB0000000000', 'XJD0000000000000']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('jd-logistics');
    }
  });

  it.each([
    ['LP00000000000001', 'aliexpress'],
    ['LP0000000000001CN', 'four-px'],
    ['1000000000016', 'delhivery'],
    ['10000000000016', 'delhivery'],
  ])('keeps %s ambiguous while allowing its direct HTTP confirmation', (number, carrier) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(number).candidates).toContain(carrier);
    expect(recognitionCandidates(number).map(candidate => candidate.carrier)).toContain(carrier);
  });

  it('anchors the two LP reference families independently of postal suffixes', () => {
    for (const number of ['LP0000000000001', 'XLP00000000000001', 'LP00000000000001CN']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('aliexpress');
    }
    for (const number of ['LP000000000001CN', 'LP00000000000001CN', 'LP0000000000001SG']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('four-px');
    }
  });

  it('includes the LP and thirteen-digit Delhivery candidates within bounded HTTP preflight', () => {
    expect(recognitionAskedCarriers('LP00000000000001')).toContain('aliexpress');
    expect(recognitionAskedCarriers('LP0000000000001CN')).toContain('four-px');
    expect(recognitionAskedCarriers('2820000000001')).toContain('delhivery');
  });

  it('ranks a carrier whose check digit passes ahead of popularity alone', () => {
    // Synthetic twelve digits; only the first passes Purolator's Luhn check.
    expect(recognitionCandidates('300000000004')[0]!.carrier).toBe('purolator');
    expect(recognitionCandidates('300000000005').map(candidate => candidate.carrier)).not.toContain('purolator');
  });

  it('names Ekart for its known merchant codes and only suggests it for other letters', () => {
    for (const number of ['FMPP0000000001', 'MYSR0000000001', 'BSIC0000000001', 'SRTP0000000001', 'fmpp 0000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ekart', confidence: 'high' });
    }
    expect(detectCarrierMatch('HRBC0123456789')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ekart'] });
    for (const number of ['PBXC0000000001', 'FMPX0000000001', 'FMPP000000001', 'FMPP00000000001', 'FM1P0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('ekart');
    }
  });

  it('selects OnTrac only in its own C and D ranges while preserving LaserShip detection', () => {
    for (const number of ['C10000000000004', 'C17000000000007', 'D10000000000003']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ontrac', confidence: 'high', candidates: ['ontrac'] });
      expect(recognitionCandidates(number)).toEqual([]);
    }
    for (const number of ['C00000000000006', 'C25000000000007', 'D00000000000005', 'D11000000000002']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ontrac'] });
      expect(recognitionCandidates(number).map(candidate => candidate.carrier)).toContain('ontrac');
    }
    for (const number of ['C10000000000001', 'C00000000000001']) expect(detectCarrierMatch(number).candidates).not.toContain('ontrac');
    expect(detectCarrierMatch('1LS0000000000001')).toMatchObject({ carrier: 'ontrac', confidence: 'high' });
  });

  it('keeps other national SPX networks outside the Philippines adapter', () => {
    for (const number of ['SPXID000000000001', 'SPXMY00000000001C']) {
      expect(detectCarrierMatch(number).carrier).not.toBe('spx-ph');
      expect(detectCarrierMatch(number).candidates).not.toContain('spx-ph');
    }
  });

  it('selects Pos Laju consignments only when their S10 check digit holds', () => {
    // The ninth digit checks the eight before it; the third letter is outside the check.
    for (const number of ['EHE000000005MY', 'ERA123456785MY', 'XYZ000000080MY', 'ehe 000000005 my']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'pos-malaysia', confidence: 'high' });
    }
    for (const number of ['EHE000000006MY', 'ERA123456780MY', 'XYZ000000085MY']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('pos-malaysia');
      expect(checksumRejections(number)).toEqual([{ carrier: 'pos-malaysia', rule: 'pos-malaysia-4', checksum: 'pos-laju' }]);
    }
  });

  it('selects China Post for ZS, ZC and ZA numbers with eleven digits, even when they close La Poste\'s key', () => {
    // The second set closes La Poste's GS1 key by chance; no La Poste number uses these prefixes.
    for (const number of ['ZS00000000001', 'ZC00000000001', 'ZA00000000001', 'zs 0000 0000 001', 'ZS00000000000', 'ZC00000000000', 'ZA00000000000']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'china-post', confidence: 'high', candidates: ['china-post'] });
      expect(recognitionAskedCarriers(number)).toEqual([]);
    }
    // Other Z prefixes and other lengths keep La Poste's broad rule alone, or nothing.
    for (const number of ['ZT00000000001', 'ZB00000000001', 'AZ00000000001', 'CZ00000000001']) {
      expect(detectCarrierMatch(number).candidates).toEqual(['la-poste']);
    }
    for (const number of ['ZC0000000001', 'ZC000000000001', 'ZC00000000001CN', 'ZA0000000001', 'ZA000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('china-post');
    }
  });

  it('names China Post for its own numbers in an ems.com.cn link', () => {
    for (const url of [
      'https://www.ems.com.cn/mailtracking/e_you_jian_cha_xun.html?mailNum=ZS00000000001',
      'http://www.ems.com.cn/qcgzOutQueryAction.do?reqCode=gotoSearchE&mailNum=RR123456785CN',
      'http://www.ems.com.cn/english.html?TrackingNumber=EE123456785CN',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ carrier: 'china-post', confidence: 'high', source: 'link' });
    }
    // China Post's tracker takes only its own numbers, so any other is detected on its own.
    expect(parseTrackingInput('http://www.ems.com.cn/english.html?TrackingNumber=EE123456785FR'))
      .toMatchObject({ carrier: 'la-poste', source: 'link' });
    expect(parseTrackingInput('http://www.ems.com.cn/mailtracking/e_you_jian_cha_xun.html?mailNum=1000000000001').carrier)
      .not.toBe('china-post');
  });

  it('gives each forwarder\'s YQ code to the carrier of its prefix alone', () => {
    // Forwarders on one Chinese platform share the YQ ending and ten digits; the customer prefix names the forwarder.
    const owners = { JSEJY0000000001YQ: 'js-express', WNBZZ0000000001YQ: 'wanbexpress', FEISH0000000001YQ: '17feia',
      SFCAA0000000001YQ: 'sfc', CJPZZA0000000001YQ: 'cj-packet', BUFZA0000000001YQ: 'buffalo-ex',
      JXCYT0000000001YQ: 'juxi-express', FARZZ0000000001YQ: 'far-international' };
    for (const [number, carrier] of Object.entries(owners)) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier, confidence: 'high', candidates: [carrier] });
      expect(recognitionCandidates(number), number).toEqual([]);
    }
    // JS Express and WanbExpress never stand in for each other.
    expect(detectCarrierMatch('JSEZZ0000000001YQ').candidates).not.toContain('wanbexpress');
    expect(detectCarrierMatch('WNBJS0000000001YQ').candidates).not.toContain('js-express');
    // A prefix no catalog forwarder uses, or a code a digit short, is left to the user.
    for (const number of ['ABCDE0000000001YQ', 'JSEJY000000001YQ', 'WNBZZ000000001YQ', 'JSWNB0000000001YQ',
      'JXCYT000000001YQ', 'JXCY0000000001YQ', 'JXCYT0000000001Y', 'FARZZ000000001YQ', 'FARZ0000000001YQ']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', candidates: [] });
    }
    expect(detectCarrierMatch('YL0000000001YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['gzyl'] });
  });

  it('names Shouwu International for SWECN, twelve digits and YQ, and only that layout', () => {
    for (const number of ['SWECN000000000017YQ', 'swecn 000000 000017 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'shouwu', confidence: 'high', candidates: ['shouwu'] });
    }
    for (const number of ['SWECN0000000017YQ', 'SWECN00000000017YQ', 'SWECN0000000000017YQ', 'SWEHK000000000017YQ',
      'SWECN000000000017', 'SWECN000000000017YT']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('shouwu');
    }
  });

  it('names KTD for KTDWE and ten digits without a recognition lookup, and only that layout', () => {
    for (const number of ['KTDWE0000000017', 'ktdwe 00000 00017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ktd', confidence: 'high', candidates: ['ktd'] });
      expect(recognitionCandidates(number), number).toEqual([]);
    }
    for (const number of ['KTDWE000000017', 'KTDWE00000000017', 'KTDWA0000000017', 'KTD0000000017', 'KTDWE0000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ktd');
    }
  });

  it('names MeiHoo Pegasus for MYH, nine digits and CN, and only that layout', () => {
    for (const number of ['MYH900000001CN', 'myh 900 000 001 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'meihoo-pegasus', confidence: 'high', candidates: ['meihoo-pegasus'] });
    }
    for (const number of ['MYH90000001CN', 'MYH9000000001CN', 'MYH900000001US', 'MYX900000001CN', 'MYH900000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('meihoo-pegasus');
    }
  });

  it('names Techlink for its dated ZHPHD waybills ending in ML', () => {
    expect(detectCarrierMatch('ZHPHD260101000001ML')).toMatchObject({ carrier: 'techlink', confidence: 'high', candidates: ['techlink'] });
    expect(detectCarrierMatch('zhphd 260101 000001 ml')).toMatchObject({ carrier: 'techlink', confidence: 'high' });
    // A month or day that cannot be a date, another prefix or ending, or a digit too many or too few is no Techlink waybill.
    for (const number of ['ZHPHD261301000001ML', 'ZHPHD260132000001ML', 'ZHPHX260101000001ML', 'ZHPHD260101000001MX',
      'ZHPHD26010100001ML', 'ZHPHD2601010000001ML', 'CJPHD260101000001ML']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('techlink');
    }
  });

  it('asks Huiyi Logistics about its lettered numbers without naming it from the shape', () => {
    expect(detectCarrierMatch('ABCD00D0000EFGH')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['hywl'] });
    expect(recognitionAskedCarriers('ABCD00D0000EFGH')).toEqual(['hywl']);
    for (const number of ['ABCD00E0000EFGH', 'ABCD00D0000EFG', 'ABC00D0000EFGH', 'ABCD000D0000EFGH', 'ABCD00D00000EFGH']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('hywl');
    }
  });

  it('asks DHLink about its line provider\'s XZG tracking numbers without naming it from the shape', () => {
    expect(detectCarrierMatch('XZG000000001WL')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('XZG000000001WL')).toEqual(['dhlink']);
    for (const number of ['XZG00000001WL', 'XZG0000000001WL', 'XZG000000001WX', 'XZH000000001WL', 'YIL000000001WL']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YLUS tracking numbers on its GOFO line without naming it from the shape', () => {
    expect(detectCarrierMatch('YLUS0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('ylus 0000 0000 01')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YLUS0000000001')).toEqual(['dhlink']);
    for (const number of ['YLUS000000001', 'YLUS00000000001', 'YLUK0000000001', 'XLUS0000000001', 'YLUS000000000A', 'YL0000000001YQ']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about EYT tracking numbers on its SwiftX line without naming it from the shape', () => {
    expect(detectCarrierMatch('EYT0000000001HZ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('EYT0000000001HZ')).toEqual(['dhlink']);
    for (const number of ['EYT000000001HZ', 'EYT00000000001HZ', 'EYT0000000001HX', 'EYZ0000000001HZ', 'XZG000000001HZ']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about QH tracking numbers on its GOFO line without naming it from the shape', () => {
    expect(detectCarrierMatch('QH000000000001FS')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('QH000000000001FS')).toEqual(['dhlink']);
    for (const number of ['QH00000000001FS', 'QH0000000000001FS', 'QH000000000001FX', 'QX000000000001FS', 'QH000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YF tracking numbers on its GOFO line without naming it from the shape', () => {
    expect(detectCarrierMatch('YF0000000001CN')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('yf 0000 0000 01 cn')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YF0000000001CN')).toEqual(['dhlink']);
    for (const number of ['YF000000001CN', 'YF00000000001CN', 'YF0000000001CX', 'YX0000000001CN', 'YF0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });
});

describe('wave seven South-East Asian courier rules', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('names SPX Express Singapore for SPXSG numbers and only suggests it for SLS numbers', () => {
    for (const number of ['SPXSG000000000011', 'SPXSG00000000001A']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'spx-sg', confidence: 'high' });
    }
    expect(detectCarrierMatch('SG0000000000011')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['spx-sg'] });
    for (const number of ['SPXSG0000000001', 'SPXSG0000000000001', 'SG000000000001', 'SG00000000000011']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('spx-sg');
    }
  });

  it('names GoTo Logistics for TKGTL numbers, with or without the hyphen', () => {
    for (const number of ['TKGTL-0000000000A', 'TKGTL0000000000A']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'gtl-goto', confidence: 'high', candidates: ['gtl-goto'] });
    }
    for (const number of ['TKGTL000000000A', 'TKGTL00000000000A', 'TKGTM0000000000A']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('gtl-goto');
    }
  });

  it('names Paxel for its dated AWB, written with or without separators', () => {
    for (const number of ['EM.000000000A-20260101-0-00000A', 'EM000000000A20260101000000A']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'paxel', confidence: 'high', candidates: ['paxel'] });
    }
    for (const number of ['EM000000000A19260101000000A', 'EM00000000A20260101000000A', 'EN000000000A20260101000000A']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('paxel');
    }
  });

  it('keeps IDexpress for its ID waybills and leaves SGX IDA air waybills unnamed', () => {
    for (const number of ['IDS000000000001', 'IDE0000000000001', 'IDA0000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'idexpress', confidence: 'high' });
    }
    expect(detectCarrierMatch('IDA000000000001').candidates ?? []).not.toContain('idexpress');
  });

  it('names the Pickupp network its region suffix shows', () => {
    expect(detectCarrierMatch('PU000000000001HK')).toMatchObject({ carrier: 'pickupp', confidence: 'high', candidates: ['pickupp'] });
    expect(detectCarrierMatch('PU000000000001SG')).toMatchObject({ carrier: 'pickupp-sg', confidence: 'high', candidates: ['pickupp-sg'] });
    for (const number of ['PU000000000001MY', 'PU00000000001HK', 'PU0000000000001SG']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      expect(candidates, number).not.toContain('pickupp');
      expect(candidates, number).not.toContain('pickupp-sg');
    }
  });
});

describe('wave seven South Asian courier rules', () => {
  it('names Valmo for VL and thirteen digits only', () => {
    expect(detectCarrierMatch('VL0000000000001')).toMatchObject({ carrier: 'valmo', confidence: 'high', candidates: ['valmo'] });
    expect(detectCarrierMatch('vl 0000 0000 00001')).toMatchObject({ carrier: 'valmo', confidence: 'high' });
    for (const number of ['VL000000000001', 'VL00000000000001', 'VA0000000000001', 'V00000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('valmo');
    }
  });
});

describe('wave eight Australian courier rules', () => {
  // Synthetic numbers in Micro Express's layout; none is a real parcel.
  it('names Micro Express for ME, thirteen digits and three letters', () => {
    expect(detectCarrierMatch('ME0000000000001AAA')).toMatchObject({ carrier: 'micro-express', confidence: 'high' });
    for (const number of ['ME000000000001AAA', 'ME00000000000001AAA', 'ME0000000000001AA', 'MX0000000000001AAA']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('micro-express');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('micro-express');
    }
  });
});

describe('Chinese fulfilment warehouse numbers', () => {
  it('names DayOne for DOT and sixteen digits, and only that layout', () => {
    for (const number of ['DOT0000000000000017', 'DOT1000000000000017', 'dot 0000 0000 0000 0017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'dayone', confidence: 'high' });
    }
    for (const number of ['DOT000000000000001', 'DOT00000000000000017', 'DOT000000000000001A', 'DOC0000000000000017']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('dayone');
    }
  });

  it('suggests Z-Leading for ZL, two letters and nine digits, and only that layout', () => {
    for (const number of ['ZLXX000000017', 'zlab 000 000 001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['z-leading'] });
    }
    for (const number of ['ZLXX00000001', 'ZLXX0000000017', 'ZLX0000000017', 'ZL0X000000017', 'ZMXX000000017', 'XLXX000000017']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('z-leading');
    }
  });
});
