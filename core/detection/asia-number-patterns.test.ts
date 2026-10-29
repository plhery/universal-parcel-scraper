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
