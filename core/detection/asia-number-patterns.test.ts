import { describe, expect, it } from 'vitest';
import { carrierIdFromName } from '../catalog/hints.js';
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
    ['LP00000000000000001', 'aliexpress'],
    ['LP0000000000001CN', 'four-px'],
    ['1000000000016', 'delhivery'],
    ['10000000000016', 'delhivery'],
  ])('keeps %s ambiguous while allowing its direct HTTP confirmation', (number, carrier) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(number).candidates).toContain(carrier);
    expect(recognitionCandidates(number).map(candidate => candidate.carrier)).toContain(carrier);
  });

  it('anchors the two LP reference families independently of postal suffixes', () => {
    for (const number of ['LP0000000000001', 'LP000000000000001', 'LP0000000000000001', 'LP000000000000000001', 'XLP00000000000001', 'LP00000000000001CN']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('aliexpress');
    }
    for (const number of ['LP000000000001CN', 'LP00000000000001CN', 'LP0000000000001SG']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('four-px');
    }
  });

  it('includes the LP and thirteen-digit Delhivery candidates within bounded HTTP preflight', () => {
    expect(recognitionAskedCarriers('LP00000000000001')).toContain('aliexpress');
    expect(recognitionAskedCarriers('LP00000000000000001')).toContain('aliexpress');
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

  it('suggests KTD after DHLink for KTDWE and ten digits, and only that layout', () => {
    for (const number of ['KTDWE0000000017', 'ktdwe 00000 00017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink', 'ktd'] });
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

  it('asks DHLink about KTD\'s KTDWE tracking numbers on its SwiftX line before a provider names KTD', () => {
    expect(detectCarrierMatch('KTDWE0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink', 'ktd'] });
    expect(recognitionAskedCarriers('KTDWE0000000001')).toEqual(['dhlink']);
    for (const number of ['KTDWE000000001', 'KTDWE00000000001', 'KTDWA0000000001', 'KTD0000000001', 'KTDWE0000000001CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YHKJ tracking numbers on its line to Britain without naming it from the shape', () => {
    expect(detectCarrierMatch('YHKJ1000000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('yhkj 1000 0000 17')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YHKJ1000000017')).toEqual(['dhlink']);
    for (const number of ['YHKJ100000017', 'YHKJ10000000017', 'YHKX1000000017', 'YHKJ1000000017CN']) {
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

  it('suggests Pengyou for three letters, nine digits and PY, and only that layout', () => {
    for (const number of ['ZZZ000000017PY', 'zzz 000 000 017 py']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pengyou'] });
    }
    for (const number of ['ZZZ00000017PY', 'ZZZ0000000017PY', 'ZZ000000017PY', 'ZZZ000000017PX', 'ZZ0000000017PY']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pengyou');
    }
  });

  it('names Jifan for JFGJ, nine digits and CN, with or without an S10 check digit', () => {
    for (const number of ['JFGJ000000017CN', 'JFGJ000000010CN', 'jfgj 000 000 017 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'jifan', confidence: 'high' });
    }
    for (const number of ['JFGJ00000017CN', 'JFGJ0000000017CN', 'JFGX000000017CN', 'JFGJ000000017CX']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('jifan');
    }
  });

  it('suggests YouBang Express for YB, ten digits and CN, and only that layout', () => {
    for (const number of ['YB0000000017CN', 'yb 0000 0000 17 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['youbang-express'] });
    }
    for (const number of ['YB000000017CN', 'YB00000000017CN', 'YC0000000017CN', 'YB0000000017CX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('youbang-express');
    }
  });

  it('names Xinghe Freight for GZXH, its company code, ten digits and YQ, and only that layout', () => {
    for (const number of ['GZXH0000000017YQ', 'gzxh 0000 0000 17 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'xinghe-freight', confidence: 'high' });
    }
    for (const number of ['GZXH000000017YQ', 'GZXH00000000017YQ', 'GZYL0000000017YQ', 'GZXH0000000017YT']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('xinghe-freight');
    }
  });

  it('names Fastbox for FB, a date and ten digits, and only that layout', () => {
    for (const number of ['FB2610010000000017', 'fb 261001 0000 000 017', 'FB1712310000000010']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'fastbox', confidence: 'high' });
    }
    for (const number of ['FB261001000000017', 'FB26100100000000017', 'FB2613010000000017', 'FB2610320000000017', 'FB2600010000000017', 'FC2610010000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fastbox');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('fastbox');
    }
  });

  it('names Meso-global for ZJKJ and ten digits, and only that layout', () => {
    for (const number of ['ZJKJ1000000017', 'zjkj 1000 0000 17']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'meso-global', confidence: 'high' });
    }
    for (const number of ['ZJKJ100000017', 'ZJKJ10000000017', 'ZJKX1000000017', 'ZJKJ1000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('meso-global');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('meso-global');
    }
  });

  it('names YDH for YDH, ten digits and YQ or AZ, and reads its tracking link', () => {
    for (const number of ['YDH1000000017YQ', 'YDH1000000017AZ', 'ydh 1000 0000 17 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ydh', confidence: 'high' });
    }
    for (const number of ['YDH100000017YQ', 'YDH10000000017YQ', 'YDX1000000017YQ', 'YDH1000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ydh');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('ydh');
    }
    expect(parseTrackingInput('https://track.ydhex.com/track_query.aspx?track_number=YDH1000000017YQ')).toMatchObject({
      trackingNumber: 'YDH1000000017YQ', carrier: 'ydh', source: 'link',
    });
  });

  it('suggests Take Send for TS, a registration date and seven digits without naming it', () => {
    for (const number of ['TS2609040000017', 'ts 260904 0000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['takesend'] });
    }
    for (const number of ['TS2613040000017', 'TS2609320000017', 'TS260904000017', 'TS26090400000017', 'TX2609040000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('takesend');
    }
    expect(parseTrackingInput('http://k5.takesend.com:8180/WebTrack?action=list&language=en&bills=TS2609040000017')).toMatchObject({
      trackingNumber: 'TS2609040000017', carrier: 'takesend', source: 'link',
    });
  });

  it('reads Joom Logistics tracking links on both of its hosts', () => {
    for (const link of ['https://joomlogistics.com/en/track?id=ZZ000000000HK', 'https://logistics.joom.com/de/track/?id=ZZ000000000HK']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'ZZ000000000HK', carrier: 'joom-logistics', source: 'link' });
    }
  });

  it('names TopYou for TYZR, a letter, ten digits and YQ, and only that layout', () => {
    for (const number of ['TYZRZ0000000017YQ', 'tyzrz 0000 0000 17 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'topyou', confidence: 'high' });
    }
    for (const number of ['TYZRZ000000001YQ', 'TYZRZ00000000017YQ', 'TYZR00000000017YQ', 'TYZXZ0000000017YQ', 'TYZRZ0000000017YX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('topyou');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('topyou');
    }
  });
});

describe('First Flight (Middle East) and DD Express links', () => {
  it('reads a First Flight (Middle East) waybill from its tracking path', () => {
    expect(parseTrackingInput('https://firstflightme.com/tracking/awb/10000017')).toMatchObject({
      trackingNumber: '10000017', carrier: 'first-flight-me', source: 'link',
    });
  });

  it('reads a DD Express tracking id from its tracker query', () => {
    expect(parseTrackingInput('https://tracking.dd.express/?tracking_ids=DD100000017')).toMatchObject({
      trackingNumber: 'DD100000017', carrier: 'dd-express', source: 'link',
    });
  });
});

describe('Boyuan tracking numbers', () => {
  it('suggests Boyuan and DHLink for BY, fourteen digits and CN, and only that layout', () => {
    for (const number of ['BY10000000000017CN', 'by 10000000000017 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['boyuan', 'dhlink'] });
    }
    for (const number of ['BY1000000000017CN', 'BY100000000000017CN', 'BY10000000000017US', 'BX10000000000017CN', 'BYHD100000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('boyuan');
    }
  });

  it('asks DHLink about the number and names Boyuan from a provider', () => {
    expect(recognitionAskedCarriers('BY10000000000017CN')).toEqual(['dhlink']);
    expect(carrierIdFromName('Boyuan')).toBe('boyuan');
    expect(carrierIdFromName('博远供应链')).toBe('boyuan');
  });

  it('reads Boyuan tracker links', () => {
    expect(parseTrackingInput('https://tms.boyuangyl.com/trackIndex.htm?documentCode=BY10000000000017CN')).toMatchObject({
      trackingNumber: 'BY10000000000017CN', carrier: 'boyuan', source: 'link',
    });
  });
});

describe('Parcel Freight Logistics numbers', () => {
  it('suggests Parcel Freight Logistics for NEXAU, ten digits and YQ only', () => {
    expect(detectCarrierMatch('NEXAU1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pflogistics'] });
    for (const number of ['ABCAU1000000017YQ', 'NEXUS1000000017YQ', 'NEXAU100000017YQ', 'NEXAU1000000017YT']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pflogistics');
    }
    expect(parseTrackingInput('https://pflogistics.com.au/tracking-result?tracking=NEXAU1000000017YQ')).toMatchObject({
      trackingNumber: 'NEXAU1000000017YQ', carrier: 'pflogistics', source: 'link',
    });
  });
});

describe('Dakota Cargo numbers, and Sentral Cargo links', () => {
  it('suggests Dakota Cargo for a branch code, month, year, A and six digits', () => {
    const match = detectCarrierMatch('001012026A000017');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toContain('dakota-cargo');
    for (const number of ['001132026A000017', '001011926A000017', '0010120260000017', '001012026B000017', '001012026A00001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dakota-cargo');
    }
  });

  it('reads Sentral Cargo tracking links', () => {
    for (const link of ['https://sentralcargo.co.id/cekresi?resi=1000017', 'https://sentralcargo.co.id/en/tracking?resi=1000017']) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: '1000017', carrier: 'sentral-cargo', source: 'link' });
    }
  });
});

describe('Kuayue Express waybills and links', () => {
  it('names Kuayue Express for KY and thirteen digits, and only that layout', () => {
    for (const number of ['KY1000000000017', 'ky 1000000000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'kuayue-express', confidence: 'high' });
    }
    for (const number of ['KY100000000017', 'KY10000000000017', 'KYE100000000017', 'KX1000000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('kuayue-express');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('kuayue-express');
    }
    expect(carrierIdFromName('跨越速运')).toBe('kuayue-express');
    expect(carrierIdFromName('KY Express')).toBe('kuayue-express');
  });

  it('reads its search page, its frame and its mobile route page', () => {
    for (const url of [
      'https://www.ky-express.com/88.html?tab=3&orders=KY1000000000017',
      'https://u.ky-express.com/diyServiceNews?tab=3&v=2.0&orders=KY1000000000017',
      'https://ic-h5.kye-erp.com/waybill-route.html#/?isShowMarketing=1&waybillNo=KY1000000000017',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'KY1000000000017', carrier: 'kuayue-express', source: 'link' });
    }
  });
});

describe('Tonami and Okaken links and names', () => {
  it('reads Tonami\'s tracker and leaves both carriers\' ten digits unruled', () => {
    expect(parseTrackingInput('https://trc1.tonami.co.jp/trc/search3/excSearch3?id%5B0%5D=1000000017')).toMatchObject({
      trackingNumber: '1000000017', carrier: 'tonami', source: 'link',
    });
    for (const carrier of ['tonami', 'okaken']) expect(detectCarrierMatch('1000000017').candidates).not.toContain(carrier);
    expect(carrierIdFromName('トナミ運輸')).toBe('tonami');
    expect(carrierIdFromName('岡山県貨物運送')).toBe('okaken');
    expect(carrierIdFromName('Okayamaken Freight Transportation')).toBe('okaken');
  });
});

describe('Inter Express Logistics and four Australian and New Zealand carriers', () => {
  it('suggests IEL for its own prefix with a valid month and day only', () => {
    expect(detectCarrierMatch('IEL6012300017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['inter-express-logistics'] });
    for (const number of ['IEL6132300017', 'IEL6013200017', 'IEL601230001', 'FCD6012300017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('inter-express-logistics');
    }
  });

  it('reads their tracker links and names', () => {
    for (const [url, number, carrier] of [
      ['https://iel.co.th/tracking/?trackingNo=IEL6012300017', 'IEL6012300017', 'inter-express-logistics'],
      ['https://iel.co.th/en/tracking/?trackingNo=IEL6012300017', 'IEL6012300017', 'inter-express-logistics'],
      ['https://www.centurion.net.au/TrackAndTrace/?track=on&con=AB10000017', 'AB10000017', 'centurion-transport'],
      ['https://my.kiwiexpress.co.nz/barcode/KO1000000017', 'KO1000000017', 'kiwi-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
    expect(carrierIdFromName('IEL - Inter Express Logistics')).toBe('inter-express-logistics');
    expect(carrierIdFromName('อินเตอร์ เอ็กซ์เพรส โลจิสติกส์')).toBe('inter-express-logistics');
    expect(carrierIdFromName('Centurion Transport Co')).toBe('centurion-transport');
    expect(carrierIdFromName('AirRoad Pty Ltd')).toBe('airroad');
    expect(carrierIdFromName('Janala Pty Limited')).toBe('cope-sensitive-freight');
    expect(carrierIdFromName('Kiwi Oversize')).toBe('kiwi-express');
  });
});

describe('ETS Express and Rincos', () => {
  it('suggests ETS Express for its RETS code only', () => {
    expect(detectCarrierMatch('RETS100000000017UES')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ets-express'] });
    for (const number of ['RETS10000000017UES', 'RETS1000000000017UES', 'RETS100000000017US', 'RETX100000000017UES']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ets-express');
    }
  });

  it('leaves Rincos numbers to the carriers that share fourteen digits', () => {
    expect(detectCarrierMatch('82100000000017').candidates ?? []).not.toContain('rincos');
  });

  it('reads their tracker links and names', () => {
    for (const url of [
      'https://www.rincos.asia/out/TraceInfo_kr.do?SCGBN=20&P_VAL=82100000000017',
      'https://www.rincos.asia/out/TraceInfo_en.do?SCGBN=20&P_VAL=82100000000017',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '82100000000017', carrier: 'rincos', source: 'link' });
    }
    expect(carrierIdFromName('RETS')).toBe('ets-express');
    expect(carrierIdFromName('俄通收国际物流')).toBe('ets-express');
    expect(carrierIdFromName('주식회사 린코스')).toBe('rincos');
    expect(carrierIdFromName('Globegistics Inc.')).toBe('asendia');
  });
});

describe('KEC eCommerce and TheLorry', () => {
  it('suggests TheLorry for TLZ and seven digits only', () => {
    expect(detectCarrierMatch('TLZ1000007').candidates).toContain('thelorry');
    for (const number of ['TLZ100007', 'TLZ10000007', 'TLX1000007']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('thelorry');
    }
  });

  it('leaves the numbers KEC eCommerce tracks to their own carriers', () => {
    expect(detectCarrierMatch('KECID10000007').candidates ?? []).not.toContain('kec-ecommerce');
    expect(detectCarrierMatch('YT2532100000000017')).toMatchObject({ carrier: 'yunexpress', confidence: 'high' });
  });

  it('reads their tracker links and names', () => {
    for (const url of [
      'https://kec.kln.com/en/logistics-tracking/?tracking=KECID10000007',
      'https://kec.kln.com/hk/track-trace/?tracking=KECID10000007',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'KECID10000007', carrier: 'kec-ecommerce', source: 'link' });
    }
    for (const url of [
      'https://tracking.thelorry.com/parcel/tracking/TLZ1000007',
      'https://bookings.thelorry.com/my/web/tracking/TLZ1000007',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'TLZ1000007', carrier: 'thelorry', source: 'link' });
    }
    expect(carrierIdFromName('Kerry eCommerce')).toBe('kec-ecommerce');
    expect(carrierIdFromName('嘉順達')).toBe('kec-ecommerce');
    expect(carrierIdFromName('The Lorry')).toBe('thelorry');
  });
});

describe('ZES Express, Profit Fields, AllJoy, DPE Express and Goodmaji', () => {
  it('suggests each forwarder for its own prefix only', () => {
    expect(detectCarrierMatch('ZESZE1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['zes-express'] });
    expect(detectCarrierMatch('EWSUS1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['profit-fields'] });
    expect(detectCarrierMatch('ALJTR2601010000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['alljoy'] });
    expect(detectCarrierMatch('ALJCD1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['alljoy'] });
    for (const number of ['ZESZE100000017YQ', 'ZESXX1000000017YQ', 'EWSUS1000000017', 'EWS1000000017YQ', 'ALJTR260101000017', 'ALJCD1000000017']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      for (const carrier of ['zes-express', 'profit-fields', 'alljoy']) expect(candidates, number).not.toContain(carrier);
    }
  });

  it('leaves DPE Express waybills to the carriers that share eleven digits', () => {
    expect(detectCarrierMatch('10000000017').candidates ?? []).not.toContain('dpe-express');
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://www.8dt.com/tracking?track=EWSUS1000000017YQ'))
      .toMatchObject({ trackingNumber: 'EWSUS1000000017YQ', carrier: 'profit-fields', source: 'link' });
    expect(parseTrackingInput('https://web.alljoylogistics.com/track?order=ALJTR2601010000017'))
      .toMatchObject({ trackingNumber: 'ALJTR2601010000017', carrier: 'alljoy', source: 'link' });
    expect(carrierIdFromName('Eshun International Logistics')).toBe('zes-express');
    expect(carrierIdFromName('俄顺国际物流')).toBe('zes-express');
    expect(carrierIdFromName('EWS Profit Fields')).toBe('profit-fields');
    expect(carrierIdFromName('8DT')).toBe('profit-fields');
    expect(carrierIdFromName('全和悦')).toBe('alljoy');
    expect(carrierIdFromName('递必易')).toBe('dpe-express');
    expect(carrierIdFromName('好馬吉')).toBe('goodmaji');
  });
});

describe('LEX Malaysia, DEX Pakistan, ShipGlobal India, Parxl, EFS Asia and Faster Express', () => {
  it('names DEX Pakistan from its hyphenated prefix and suggests LEX and ShipGlobal for their own layouts', () => {
    for (const number of ['PK-DEX100000017', 'pk DEX 100000017', 'PKDEX100000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'dex-pk', confidence: 'high' });
    }
    expect(detectCarrierMatch('TMYLE100000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['lex-my'] });
    expect(detectCarrierMatch('SG32610010000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['shipglobal-in'] });
    for (const number of ['PK-DEX10000017', 'LK-DEX-100000017', 'TMYLE10000017', 'TMYSU100000017', 'SG32613010000017', 'SG32610320000017', 'SG3261001000017']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      for (const carrier of ['dex-pk', 'lex-my', 'shipglobal-in']) expect(candidates, number).not.toContain(carrier);
    }
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://lex.com.my/tracking?references=TMYLE100000017'))
      .toMatchObject({ trackingNumber: 'TMYLE100000017', carrier: 'lex-my', source: 'link' });
    expect(parseTrackingInput('https://www.dex.com.pk/tracking?references=PK-DEX100000017'))
      .toMatchObject({ carrier: 'dex-pk', source: 'link' });
    expect(parseTrackingInput('https://shipglobal.in/tracking/?awb=SG32610010000017'))
      .toMatchObject({ trackingNumber: 'SG32610010000017', carrier: 'shipglobal-in', source: 'link' });
    expect(parseTrackingInput('https://track.parxl.com/PX10000017')).toMatchObject({ trackingNumber: 'PX10000017', carrier: 'parxl', source: 'link' });
    expect(parseTrackingInput('https://web.efs.asia/script/users/tracking.php?search_no=EFS10000017&mode=search&lang='))
      .toMatchObject({ trackingNumber: 'EFS10000017', carrier: 'efs-asia', source: 'link' });
    expect(parseTrackingInput('https://faster.ae/track?no=FST10000000017')).toMatchObject({ trackingNumber: 'FST10000000017', carrier: 'faster-ae', source: 'link' });
    expect(carrierIdFromName('Lazada Express Malaysia')).toBe('lex-my');
    expect(carrierIdFromName('Daraz Express Pakistan')).toBe('dex-pk');
    expect(carrierIdFromName('DEX PK')).toBe('dex-pk');
    expect(carrierIdFromName('Ship Global Express')).toBe('shipglobal-in');
    expect(carrierIdFromName('SIA Parxl')).toBe('parxl');
    expect(carrierIdFromName('이에프에스')).toBe('efs-asia');
    expect(carrierIdFromName('迅捷中东物流')).toBe('faster-ae');
    // Lazada and Daraz run their networks in several countries on separate sites.
    expect(carrierIdFromName('Lazada Express')).toBeUndefined();
    expect(carrierIdFromName('Daraz Express')).toBeUndefined();
  });
});

describe('Shipter, Tonda Global, Liuchen, EAC and LBTX', () => {
  it('suggests Shipter for its own layout beside the broad Colis Privé shape', () => {
    expect(detectCarrierMatch('H3AU100017KR')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['shipter']) });
    for (const number of ['H3AU10017KR', 'H3AU1000017KR', 'H3A1100017KR', 'H4AU100017KR', 'H3AU100017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('shipter');
    }
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://www.shipter.kr/tracking/H3AU100017KR'))
      .toMatchObject({ trackingNumber: 'H3AU100017KR', carrier: 'shipter', source: 'link' });
    expect(parseTrackingInput('https://shiptertracking.com/trackingResult/H3AU100017KR'))
      .toMatchObject({ trackingNumber: 'H3AU100017KR', carrier: 'shipter', source: 'link' });
    expect(parseTrackingInput('https://www.tarrive.com/track?q=TD1000000017'))
      .toMatchObject({ trackingNumber: 'TD1000000017', carrier: 'tonda-global', source: 'link' });
    expect(parseTrackingInput('https://www.liuchenwl.com/index/tracknumber/track?nos=LC1000000017'))
      .toMatchObject({ trackingNumber: 'LC1000000017', carrier: 'liuchen', source: 'link' });
    expect(carrierIdFromName('H3 Networks')).toBe('shipter');
    expect(carrierIdFromName('通达全球')).toBe('tonda-global');
    expect(carrierIdFromName('六尘物流')).toBe('liuchen');
    expect(carrierIdFromName('富皇美运')).toBe('eac-cn');
    expect(carrierIdFromName('龙本天下')).toBe('lbtx');
  });
});

describe('Super Parcel Track, Ural Express, Onex, GCX, Tusou and Wise Express', () => {
  it('reads Super Parcel Track\'s and Ant Parcel\'s tracker links, and names Ant Parcel as Super Parcel Track', () => {
    for (const url of ['https://track-sp.com/tracking/detail?tracking_num=AP0000000001', 'https://ant-parcel.com/tracking/detail?tracking_num=AP0000000001',
      'https://ant-parcel.com/tracking/detail/AP0000000001']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'AP0000000001', carrier: 'super-parcel-track', source: 'link' });
    }
    expect(carrierIdFromName('Ant Parcel')).toBe('super-parcel-track');
  });

  it('reads their names and Tusou\'s tracker links', () => {
    expect(parseTrackingInput('https://tusou.kingtrans.net/WebTrack?action=list&language=en&istrack=false&bills=TS1000000017'))
      .toMatchObject({ trackingNumber: 'TS1000000017', carrier: 'tusou', source: 'link' });
    expect(carrierIdFromName('Super Parcel')).toBe('super-parcel-track');
    expect(carrierIdFromName('乌拉尔国际物流')).toBe('ural-express');
    expect(carrierIdFromName('Onex Armenia')).toBe('onex');
    expect(carrierIdFromName('Global Courier Express')).toBe('gcx');
    expect(carrierIdFromName('图搜网络科技')).toBe('tusou');
    expect(carrierIdFromName('万色速递')).toBe('wise-express');
    // WanB Express is a different company.
    expect(carrierIdFromName('WanB Express')).not.toBe('wise-express');
  });

  it('leaves the inbound carrier\'s number on an Onex tracker link to that carrier', () => {
    // Onex tracks parcels by the number of the carrier that brought them to its warehouse.
    expect(parseTrackingInput('https://onex.am/en/onextrack?track=RR100000017AM').carrier).not.toBe('onex');
  });
});

describe('Morning Global waybills', () => {
  it('suggests Morning Global for BR, nine digits and MG that fail the S10 check, and asks it', () => {
    expect(detectCarrierMatch('BR000000017MG')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['morning-global'] });
    expect(recognitionAskedCarriers('BR000000017MG')).toEqual(['morning-global']);
    expect(detectCarrierMatch('BR000000014MG').carrier).toBe('intl-post');
    for (const number of ['BR00000017MG', 'BR0000000017MG', 'BX000000017MG', 'BR000000017MX', 'HK000000017PH01']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('morning-global');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('morning-global');
    }
  });
});

describe('Holisol, and four Australian couriers', () => {
  it('reads their trackers\' links', () => {
    for (const [url, trackingNumber, carrier] of [
      ['https://www.holisoldelivery.com/api/tracking/TrackAwb?awb=HL00000000001', 'HL00000000001', 'holisol'],
      ['https://online.amaldist.com.au/track/?item=1000001', '1000001', 'amalgamated-distribution'],
      ['https://web.victorianfreight.com.au/webconsignment/FTSSearch-v2.aspx?connum=1000001', '1000001', 'victorian-freight-specialists'],
      ['https://portal.vtfe.com.au/Track/VTFE/ZZZZ0000001', 'ZZZZ0000001', 'vt-freight-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber, carrier, source: 'link' });
    }
  });

  it('names them from their names', () => {
    expect(carrierIdFromName('Holisol Logistics')).toBe('holisol');
    expect(carrierIdFromName('Bonds Transport Group')).toBe('bonds-couriers');
    expect(carrierIdFromName('Amaldist')).toBe('amalgamated-distribution');
    expect(carrierIdFromName('Victorian Freight Specialists')).toBe('victorian-freight-specialists');
    expect(carrierIdFromName('VicTas Freight Express')).toBe('vt-freight-express');
  });
});
