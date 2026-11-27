import { afterEach, describe, expect, it, vi } from 'vitest';
import { countryFlag, countryName, trackingLocationCountries, trackingLocationCountry, trackingPlace } from './trackingLocation.js';

describe('tracking places', () => {
  it.each([
    ['Zürich, Schweiz', 'CH', 'Zürich'], ['Bâle (Suisse)', 'CH', 'Bâle'], ['Milano, Italia', 'IT', 'Milano'],
    ['Paris; France', 'FR', 'Paris'], ['London, UK', 'GB', 'London'], ['ZUERICH, CH', 'CH', 'ZUERICH'],
    ['Zürich (Mülligen), CH', 'CH', 'Zürich (Mülligen)'], ['Hebron, KY, US, US', 'US', 'Hebron, KY'],
    ['Switzerland Haerkingen', 'CH', 'Haerkingen'], ['United Kingdom Coventry', 'GB', 'Coventry'],
    ['LANGLEY HWDC, UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND', 'GB', 'LANGLEY HWDC'],
    ['Shenzhen-Futian, China', 'CN', 'Shenzhen-Futian'], ['GREAT BRITAIN AND NORTHERN IRELAND', 'GB', ''],
    ["Mainland China, People's Republic of China", 'CN', ''], ["SHENZHEN - THE PEOPLE'S REPUBLIC OF CHINA", 'CN', 'SHENZHEN'],
    // A state's official name.
    ['Riyadh, Kingdom of Saudi Arabia', 'SA', 'Riyadh'], ['Berlin, Federal Republic of Germany', 'DE', 'Berlin'],
    ['BENIN CITY - NIGERIA', 'NG', 'BENIN CITY'], ['AMSTERDAM - NETHERLANDS, THE', 'NL', 'AMSTERDAM'],
    ['HONG KONG - HONG KONG SAR, CHINA', 'HK', 'HONG KONG'], ['STERLING - Virginia - USA', 'US', 'STERLING - Virginia'],
    ['ATLANTA - GEORGIA - USA', 'US', 'ATLANTA - GEORGIA'],
    // A code before a dot, as CNE names its facilities.
    ['CN.CNE East China Sort Facility', 'CN', 'CNE East China Sort Facility'], ['CN.Shenzhen', 'CN', 'Shenzhen'],
  ])('takes the country off %s', (location, country, place) => {
    expect(trackingPlace(location)).toEqual({ country, place });
  });

  it('reads a code a state or canton shares as the country another field names', () => {
    expect(trackingPlace('HOLLAND, NL')).toEqual({ country: 'NL', place: 'HOLLAND' });
    expect(trackingPlace('Example Town, HOLLAND, NL')).toEqual({ country: 'NL', place: 'Example Town, HOLLAND' });
    expect(trackingPlace('Luxembourg, LU')).toEqual({ country: 'LU', place: 'Luxembourg' });
    expect(trackingPlace("St. John's, NL")).toEqual({ country: null, place: "St. John's, NL" });
  });

  it.each([
    ['France', 'FR'], ['DE', 'DE'], ['CH ', 'CH'], ['THE NETHERLANDS', 'NL'], ['Czech Republic', 'CZ'], ['Hong Kong', 'HK'],
    ['DHL Netherlands', 'NL'], ['КИТАЙ', 'CN'], ['Україна', 'UA'], ['日本', 'JP'], ['美國', 'US'], ['China VR', 'CN'], ['VR China', 'CN'],
    // Between empty fields, and a partner's depot abroad by its number.
    [',,,DE', 'DE'], ['FR,', 'FR'], ['SPAIN (12)', 'ES'], ['Republic of Moldova', 'MD'], ['Kingdom of the Netherlands', 'NL'],
  ])('leaves no place when %s is only a country', (location, country) => {
    expect(trackingPlace(location)).toEqual({ country, place: '' });
  });

  it.each([
    '', 'Warehouse', 'Paris', 'Buchs AG', 'Basel, BS', 'Wilmington, DE', 'France distribution center',
    'Zürich Briefzentrum', 'Mexico City', 'Andorra la Vella',
    'DHL Paris', 'DHL Netherlands distribution centre', 'JAMAICA NY INTERNATIONAL DISTRIBUTION CENTER', 'Panama City FL',
    'TBILISI - GEORGIA', 'CURITIBA - PR', 'ST.LOUIS', 'PT.ELIZABETH',
    // A short name two states share.
    'Republic of China', "Democratic People's Republic of Korea",
  ])('keeps %s whole without guessing a country', (location) => {
    expect(trackingPlace(location)).toEqual({ country: null, place: location });
  });

  it("reads an Italian province's code in brackets after the town as no country", () => {
    // Synthetic towns and provinces: Bologna's, Turin's, Venice's and Cuneo's codes are Bolivia's, Tonga's,
    // Venezuela's and China's.
    for (const location of ['BENTIVOGLIO (BO)', 'Bologna (BO)', 'TORINO (TO)', 'PORTOGRUARO ( VE )', 'ALBA (CN)', 'ROMA (RM)']) {
      expect(trackingPlace(location)).toEqual({ country: null, place: location });
      expect(trackingLocationCountry(location)).toBeNull();
    }
    // A country named after it still counts, and a code of no province stays a country.
    expect(trackingPlace('BENTIVOGLIO (BO), IT')).toEqual({ country: 'IT', place: 'BENTIVOGLIO (BO)' });
    expect(trackingLocationCountry('BENTIVOGLIO (BO), Italia')).toBe('IT');
    expect(trackingPlace('Poznań (PL)')).toEqual({ country: 'PL', place: 'Poznań' });
    expect(trackingPlace('BO')).toEqual({ country: 'BO', place: '' });
    expect(trackingPlace('Santa Cruz, BO')).toEqual({ country: 'BO', place: 'Santa Cruz' });
  });

  it("reads a region's code as its country where the parcel may be", () => {
    // Synthetic towns. Bologna's code is Bolivia's, Paraná's Puerto Rico's, Kentucky's the Cayman Islands', Aargau's
    // Antigua's.
    expect(trackingLocationCountry('EXAMPLE TOWN (BO)', { countries: ['IT'] })).toBe('IT');
    expect(trackingPlace('EXAMPLE TOWN (BO)', { countries: ['IT'] })).toEqual({ country: 'IT', place: 'EXAMPLE TOWN (BO)' });
    expect(trackingLocationCountry('EXAMPLE TOWN - PR', { countries: ['BR'] })).toBe('BR');
    expect(trackingPlace('EXAMPLE TOWN/PR', { countries: ['BR'] })).toEqual({ country: 'BR', place: 'EXAMPLE TOWN/PR' });
    expect(trackingLocationCountry('EXAMPLE TOWN, KY', { countries: ['US'] })).toBe('US');
    expect(trackingPlace('Hebron, KY, US', { countries: ['US'] })).toEqual({ country: 'US', place: 'Hebron, KY' });
    expect(trackingLocationCountry('EXAMPLE TOWN AG', { countries: ['CH'] })).toBe('CH');
    expect(trackingLocationCountry('EXAMPLE TOWN AG', { placed: 'CH' })).toBe('CH');
    // The town's own country settles any form, and its own code goes from the place.
    expect(trackingLocationCountry('EXAMPLE TOWN BO', { placed: 'IT' })).toBe('IT');
    expect(trackingPlace('MILANO IT', { placed: 'IT' })).toEqual({ country: 'IT', place: 'MILANO' });
    // A real stop in Bolivia stays there.
    expect(trackingLocationCountry('Santa Cruz (BO)', { countries: ['BO'] })).toBe('BO');
    expect(trackingLocationCountry('Santa Cruz, BO', { countries: ['IT'] })).toBe('BO');
    expect(trackingLocationCountry('Santa Cruz (BO)', { placed: 'BO', countries: ['IT'] })).toBe('BO');
    // A code either the parcel's country or a region of another of its countries names none.
    expect(trackingLocationCountry('EXAMPLE TOWN (BO)', { countries: ['IT', 'BO'] })).toBeNull();
    expect(trackingLocationCountry('EXAMPLE TOWN, DE', { countries: ['DE', 'US'] })).toBeNull();
    // Countries whose addresses write no region's code keep their neighbours' codes: the Canaries' and Cuneo's code
    // is China's, Berlin's is Belgium's.
    expect(trackingLocationCountry('Shenzhen, CN', { countries: ['ES'] })).toBe('CN');
    expect(trackingLocationCountry('Shenzhen, CN', { countries: ['IT'] })).toBe('CN');
    expect(trackingLocationCountry('Bruxelles, BE', { countries: ['DE'] })).toBe('BE');
    // With nothing known of the parcel, a code a state or canton shares names no country.
    expect(trackingLocationCountry('EXAMPLE TOWN, DE', { countries: ['GB'] })).toBe('DE');
    expect(trackingLocationCountry('EXAMPLE TOWN, DE')).toBeNull();
    expect(trackingLocationCountry('EXAMPLE TOWN - PR')).toBeNull();
    expect(trackingPlace('EXAMPLE TOWN AG')).toEqual({ country: null, place: 'EXAMPLE TOWN AG' });
  });

  it('drops a region-like code its neighbours could not have left for', () => {
    const scans = (gap: number) => [
      { location: 'Milano, IT', time: '2026-01-05T08:00:00Z' },
      { location: 'EXAMPLE TOWN, BO', time: new Date(Date.parse('2026-01-05T08:00:00Z') + gap * 3_600_000).toISOString() },
      { location: 'Bologna, IT', time: new Date(Date.parse('2026-01-05T08:00:00Z') + 2 * gap * 3_600_000).toISOString() },
    ];
    expect(trackingLocationCountries(scans(2))).toEqual([{ country: 'IT' }, { country: null, implausible: 'BO' }, { country: 'IT' }]);
    // Days apart, the trip could be real.
    expect(trackingLocationCountries(scans(48)).map(({ country }) => country)).toEqual(['IT', 'BO', 'IT']);
    // Scans around it in Italy make a code in brackets Italy's province.
    expect(trackingLocationCountries([
      { location: 'Milano, IT', time: '2026-01-05T08:00:00Z' },
      { location: 'EXAMPLE TOWN (BO)', time: '2026-01-06T08:00:00Z' },
    ]).map(({ country }) => country)).toEqual(['IT', 'IT']);
    // A real stop in Bolivia, with stops in Bolivia around it, and a country the carrier gave in a field of its own.
    expect(trackingLocationCountries([
      { location: 'La Paz, BO', time: '2026-01-05T08:00:00Z' },
      { location: 'EXAMPLE TOWN (BO)', time: '2026-01-05T09:00:00Z' },
      { location: 'Cochabamba, BO', time: '2026-01-05T10:00:00Z' },
    ], ['IT']).map(({ country }) => country)).toEqual(['BO', 'BO', 'BO']);
    expect(trackingLocationCountries([
      { location: 'Milano, IT', time: '2026-01-05T08:00:00Z' },
      { location: 'EXAMPLE TOWN, BO', time: '2026-01-05T09:00:00Z', country: 'BO' },
      { location: 'Bologna, IT', time: '2026-01-05T10:00:00Z' },
    ]).map(({ country }) => country)).toEqual(['IT', 'BO', 'IT']);
    // A country written in words is not a region's code.
    expect(trackingLocationCountries([
      { location: 'Milano, IT', time: '2026-01-05T08:00:00Z' },
      { location: 'EXAMPLE TOWN, BOLIVIA', time: '2026-01-05T09:00:00Z' },
      { location: 'Bologna, IT', time: '2026-01-05T10:00:00Z' },
    ]).map(({ country }) => country)).toEqual(['IT', 'BO', 'IT']);
  });

  it('reads a US military post office as no country', () => {
    // "AE" after APO, FPO or DPO is the Armed Forces Europe, not the United Arab Emirates.
    for (const location of ['Fpo, AE', 'APO, AE 09001', 'DPO AP', 'EXAMPLE BASE, APO AA 34001']) {
      expect(trackingPlace(location), location).toEqual({ country: null, place: location });
      expect(trackingLocationCountry(location), location).toBeNull();
    }
    expect(trackingPlace('Example City, AE')).toEqual({ country: 'AE', place: 'Example City' });
  });

  it('reads a localized country name a large town shares as the town', () => {
    for (const location of ['Granada', 'GRANADA', 'Franca', 'Salvador', 'Santa Helena', 'Włochy', 'Granada Centro']) {
      expect(trackingPlace(location), location).toEqual({ country: null, place: location });
    }
    expect(trackingLocationCountry('Andalucía, Granada')).toBeNull();
    // The English name still reads, and so does a country's name in its own language.
    expect(trackingPlace('Grenada')).toEqual({ country: 'GD', place: '' });
    expect(trackingPlace('Polska')).toEqual({ country: 'PL', place: '' });
  });

  it('keeps Passport evidence to a final field that names a region', () => {
    expect(trackingLocationCountry('Zürich, CH')).toBe('CH');
    expect(trackingLocationCountry('Switzerland Haerkingen')).toBeNull();
    expect(trackingLocationCountry('Czech Republic')).toBeNull();
  });

  afterEach(() => vi.restoreAllMocks());

  it('reads and names China where the runtime calls it “China mainland”, as Safari does', async () => {
    const of = Intl.DisplayNames.prototype.of;
    vi.spyOn(Intl.DisplayNames.prototype, 'of').mockImplementation(function (this: Intl.DisplayNames, code: string) {
      return code === 'CN' ? 'China mainland' : of.call(this, code);
    });
    vi.resetModules();
    const fresh = await import('./trackingLocation.js');
    expect(fresh.trackingPlace('Shenzhen, China')).toEqual({ country: 'CN', place: 'Shenzhen' });
    expect(fresh.trackingLocationCountry('Canton, Chine')).toBe('CN');
    expect(fresh.countryName('CN', 'en-GB')).toBe('China');
    expect(fresh.countryName('CN', 'fr')).toBe('Chine');
    expect(fresh.trackingPlace('КИТАЙ')).toEqual({ country: 'CN', place: '' });
  });

  it('names the country in the reader’s language', () => {
    expect(countryFlag('CH')).toBe('🇨🇭');
    expect(countryName('CZ', 'de')).toBe('Tschechien');
    expect(countryName('FI', 'fr')).toBe('Finlande');
    expect(countryName('HK', 'en')).toBe('Hong Kong');
  });
});
