import { describe, expect, it, vi } from 'vitest';
import { locatePlace, placesForEvents } from './index.js';

vi.setConfig({ testTimeout: 30_000 });

const place = (location: string, countries?: string[]) => locatePlace(location, { countries });

function expectPlace(location: string, expected: { country: string; name: string; latitude: number; longitude: number }, countries?: string[]) {
  const found = place(location, countries);
  expect(found, location).toMatchObject({ precision: 'city', country: expected.country, name: expected.name });
  expect(found!.latitude, location).toBeCloseTo(expected.latitude, 1);
  expect(found!.longitude, location).toBeCloseTo(expected.longitude, 1);
}

describe('locatePlace', () => {
  it('places a country operation without inventing a city', () => {
    expect(place('DHL Netherlands')).toMatchObject({ country: 'NL', precision: 'country', name: 'Netherlands' });
  });

  it('reads the formats carriers print, with or without a country', () => {
    const zurich = { country: 'CH', name: 'Zürich', latitude: 47.37, longitude: 8.55 };
    for (const location of ['ZUERICH, CH', 'ZUERICH CH', 'ZURICH']) expectPlace(location, zurich);
    // Mixed case is the carrier's own spelling, and the journal shows the same.
    expectPlace('Zurich, CH', { ...zurich, name: 'Zurich' });
    expectPlace('Switzerland Zurich', { ...zurich, name: 'Zurich' });
    expectPlace('Urdorf, CH', { country: 'CH', name: 'Urdorf', latitude: 47.39, longitude: 8.43 });
    expectPlace('KOELN, DE', { country: 'DE', name: 'Köln', latitude: 50.93, longitude: 6.95 });
    expectPlace('SEOUL, KR', { country: 'KR', name: 'Seoul', latitude: 37.57, longitude: 126.98 });
    expectPlace('Paris, Île-de-France, FR', { country: 'FR', name: 'Paris', latitude: 48.85, longitude: 2.35 });
    expectPlace('LONDON', { country: 'GB', name: 'London', latitude: 51.51, longitude: -0.13 });
    expectPlace('BARCELONA2', { country: 'ES', name: 'Barcelona', latitude: 41.39, longitude: 2.16 });
  });

  it('uses states and provinces to pick the right town of a shared name', () => {
    expectPlace('LAUREL, MD 20707', { country: 'US', name: 'Laurel', latitude: 39.1, longitude: -76.85 });
    expectPlace('WASHINGTON, DC 20212', { country: 'US', name: 'Washington', latitude: 38.9, longitude: -77.04 });
    expectPlace('Calgary, AB, CA', { country: 'CA', name: 'Calgary', latitude: 51.05, longitude: -114.09 });
    expectPlace('OTTAWA, ON', { country: 'CA', name: 'Ottawa', latitude: 45.41, longitude: -75.7 });
    expectPlace('Sausheim 68 (68)', { country: 'FR', name: 'Sausheim', latitude: 47.79, longitude: 7.37 });
    expectPlace('Buchs AG', { country: 'CH', name: 'Buchs', latitude: 47.39, longitude: 8.08 }, ['CH']);
    // A state the text gives holds: Earth City in Missouri, not Earth in Texas.
    expectPlace('Earth City, MO, United States', { country: 'US', name: 'Earth City', latitude: 38.77, longitude: -90.47 });
    expectPlace('Earth, TX', { country: 'US', name: 'Earth', latitude: 34.23, longitude: -102.41 });
  });

  it('tells a province or an office code from a country', () => {
    // Royal Mail ends its mail centres with MC and its delivery offices with DO: not Monaco, nor the Dominican Republic.
    expectPlace('Norwich MC', { country: 'GB', name: 'Norwich', latitude: 52.63, longitude: 1.3 });
    expectPlace('Coventry South DO', { country: 'GB', name: 'Coventry', latitude: 52.41, longitude: -1.51 });
    // A town of the code's country keeps it.
    expectPlace('MONTE CARLO MC', { country: 'MC', name: 'Monte-Carlo', latitude: 43.74, longitude: 7.43 });
    expectPlace('SANTO DOMINGO DO', { country: 'DO', name: 'Santo Domingo', latitude: 18.47, longitude: -69.89 });
    // Turin's province in brackets, not Tonga; the state of Bahia, not the Bahamas.
    expectPlace('PINEROLO (TO)', { country: 'IT', name: 'Pinerolo', latitude: 44.89, longitude: 7.33 });
    expectPlace('SALVADOR, BA', { country: 'BR', name: 'Salvador', latitude: -12.98, longitude: -38.49 });
    // Spain, unless the parcel is in Brazil, where ES is Espírito Santo.
    expect(place('VITORIA, ES')).toMatchObject({ precision: 'city', country: 'ES' });
    expect(place('VITORIA, ES', ['BR'])).toMatchObject({ precision: 'city', country: 'BR' });
    // A state the lookup has no code for, on a parcel in its country.
    expectPlace('MUMBAI, MH', { country: 'IN', name: 'Mumbai', latitude: 19.07, longitude: 72.88 }, ['IN']);
    // No town before the code, on a parcel known elsewhere: no country either.
    expect(place('Home Counties North MC', ['GB'])).toBeNull();
    expect(place('UFFICIO POSTALE (TO)', ['IT'])).toBeNull();
    // The parcel's own country is one.
    expect(place('MOKRONOS DOLNY (PL)', ['PL'])).toMatchObject({ precision: 'country', country: 'PL' });
    expect(place('Example Hub, CH', ['FR'])).toMatchObject({ precision: 'country', country: 'CH' });
  });

  it('reads DHL Express lines that end in a state or a country after a dash', () => {
    expectPlace('STERLING - Virginia - USA', { country: 'US', name: 'Sterling', latitude: 39.01, longitude: -77.43 });
    expectPlace('BENIN CITY - NIGERIA', { country: 'NG', name: 'Benin City', latitude: 6.34, longitude: 5.63 });
    expectPlace('LONDON - CANADA', { country: 'CA', name: 'London', latitude: 42.98, longitude: -81.23 });
    expectPlace('AMSTERDAM - NETHERLANDS, THE', { country: 'NL', name: 'Amsterdam', latitude: 52.37, longitude: 4.89 });
    expectPlace('HONG KONG - HONG KONG SAR, CHINA', { country: 'HK', name: 'Hong Kong', latitude: 22.28, longitude: 114.18 });
    // A Brazilian state, not Puerto Rico.
    expectPlace('CURITIBA - PR', { country: 'BR', name: 'Curitiba', latitude: -25.43, longitude: -49.27 });
    expectPlace('PANAMA CITY PA', { country: 'PA', name: 'Panama City', latitude: 8.99, longitude: -79.52 });
    // Queens, not the island.
    expectPlace('JAMAICA NY INTERNATIONAL DISTRIBUTION CENTER', { country: 'US', name: 'Jamaica', latitude: 40.69, longitude: -73.81 });
  });

  it('places the cities Toronto absorbed, which Canada Post still addresses', () => {
    const scarborough = { country: 'CA', name: 'Scarborough', latitude: 43.77, longitude: -79.25 };
    expectPlace('SCARBOROUGH - ONTARIO - CANADA', scarborough);
    expectPlace('SCARBOROUGH - ON - CANADA', scarborough);
    expectPlace('Scarborough, ON', scarborough);
    expectPlace('NORTH YORK - ONTARIO - CANADA', { country: 'CA', name: 'North York', latitude: 43.75, longitude: -79.44 });
    // Unconfirmed, the town in England is still the one meant.
    expectPlace('Scarborough', { country: 'GB', name: 'Scarborough', latitude: 54.28, longitude: -0.4 });
  });

  it('puts a scan at the airport or hub it names', () => {
    expect(place('Frankfurt Airport (FRA), Germany')).toMatchObject({ country: 'DE', name: 'Frankfurt', site: 'Frankfurt Main Airport', latitude: 50.027, longitude: 8.558 });
    expect(place('LONDON-HEATHROW - UK')).toMatchObject({ country: 'GB', name: 'London', site: 'London Heathrow Airport', latitude: 51.471, longitude: -0.46 });
    expect(place('HELSINKI-VANTAAN LENTOASEMA')).toMatchObject({ country: 'FI', name: 'Helsinki', site: 'Helsinki Vantaa Airport' });
    expect(place('LIEGE AIRPORT')).toMatchObject({ country: 'BE', name: 'Liège', site: 'Liège Airport' });
    // Roissy is the airport, not Roissy-en-Brie on the other side of Paris.
    expect(place('ROISSY COURRIER INTERNATIONAL')).toMatchObject({ country: 'FR', name: 'Roissy-en-France', site: 'Charles de Gaulle International Airport' });
    expect(place('EAST MIDLANDS - UK')).toMatchObject({ country: 'GB', site: 'East Midlands Airport' });
    // A hub in a village the gazetteer does not list.
    for (const location of ['SEKOCIN STARY PL', 'SEKOCIN STARY, PL', 'Sekocin Stary, Poland']) {
      expect(place(location), location).toEqual({ precision: 'city', country: 'PL', name: location.startsWith('SEKOCIN') ? 'Sękocin Stary' : 'Sekocin Stary', latitude: 52.108, longitude: 20.88 });
    }
    // Cainiao's sorting centre in Fenggang, Dongguan, which GeoNames gives no population; not Fenggang in Jiangxi.
    expect(place('Fenggang Town')).toEqual({ precision: 'city', country: 'CN', name: 'Fenggang Town', latitude: 22.757, longitude: 114.149 });
    expect(place('FENGGANG TOWN', ['FR'])).toMatchObject({ country: 'CN', name: 'Fenggang', latitude: 22.757 });
    // Royal Mail's international hub by Heathrow, in a Langley the gazetteer does not list; not Langley in Canada.
    expect(place('LANGLEY HWDC')).toEqual({ precision: 'city', country: 'GB', name: 'Langley', latitude: 51.497, longitude: -0.532 });
    expect(place('LANGLEY', ['GB'])).toMatchObject({ country: 'GB', latitude: 51.497 });
    expect(place('LANGLEY BC')).toMatchObject({ country: 'CA', name: 'Langley' });
    expect(place('KINGS LANGLEY', ['GB'])).toMatchObject({ country: 'GB', name: 'Kings Langley', latitude: 51.714 });
    // Mondial Relay's agency in Terrasson-Lavilledieu, under the town's short name.
    expect(place('TERRASSON', ['FR'])).toEqual({ precision: 'city', country: 'FR', name: 'Terrasson-Lavilledieu', latitude: 45.129, longitude: 1.32 });
    expect(place('Agence de Terrasson')).toMatchObject({ country: 'FR', latitude: 45.129, longitude: 1.32 });
    // Royal Mail's mail centres named after an area, and Cainiao's warehouse in Shatian, Dongguan.
    expect(place('South Midlands MC')).toEqual({ precision: 'city', country: 'GB', name: 'Northampton', site: 'South Midlands Mail Centre', latitude: 52.216, longitude: -0.953 });
    expect(place('Princess Royal Parcel Hub')).toMatchObject({ country: 'GB', name: 'London', site: 'Princess Royal Distribution Centre', latitude: 51.541 });
    // Its parcel super hubs, by Warrington and Daventry.
    expect(place('North West Super Hub')).toEqual({ precision: 'city', country: 'GB', name: 'Warrington', site: 'North West Super Hub', latitude: 53.409, longitude: -2.666 });
    expect(place('MIDLANDS SUPER HUB')).toEqual({ precision: 'city', country: 'GB', name: 'Daventry', site: 'Midlands Super Hub', latitude: 52.371, longitude: -1.172 });
    expect(place('Shatian Town')).toEqual({ precision: 'city', country: 'CN', name: 'Shatian Town', latitude: 22.923, longitude: 113.613 });
    // A longer name that contains a hub's is that place.
    expect(place('Terrasson-Lavilledieu', ['FR'])).toMatchObject({ country: 'FR', name: 'Terrasson-Lavilledieu' });
    expect(place('Terrasson-Lavilledieu', ['FR'])!.longitude).toBeCloseTo(1.3, 2);
    expect(place('BEAUREGARD DE TERRASSON', ['FR'])).toMatchObject({ country: 'FR', name: 'Beauregard-de-Terrasson' });
    expect(place('Beauregard-de-Terrasson')).toBeNull();
    expect(place('Roissy-en-Brie')).toMatchObject({ country: 'FR', name: 'Roissy-en-Brie' });
    // A country or a region in the text names no airport.
    for (const location of ['Cuernavaca, Mexico', 'HSINCHU - TAIWAN', 'Soyapango, San Salvador']) expect(place(location)?.site, location).toBeUndefined();
  });

  it("knows a carrier's own hub by the name the carrier gives it", () => {
    // DPD's Swiss depot is in Buchs in the canton of Zurich; any other Buchs still has to say so.
    expect(locatePlace('Buchs, CH', { carriers: ['dpd'] })).toMatchObject({ country: 'CH', name: 'Buchs', latitude: 47.452, longitude: 8.43 });
    expect(locatePlace('Buchs SG', { carriers: ['dpd'] })).toMatchObject({ latitude: 47.167, longitude: 9.478 });
    expect(place('Buchs, CH')).toMatchObject({ latitude: 47.167, longitude: 9.478 });
    // DHL's parcel centre is in Staufenberg in Lower Saxony, not the town in Hesse.
    expect(locatePlace('Staufenberg', { countries: ['DE'], carriers: ['dhl-ecommerce'] })).toMatchObject({ country: 'DE', latitude: 51.372, longitude: 9.634 });
    expect(place('Staufenberg', ['DE'])).toMatchObject({ country: 'DE', latitude: 50.662, longitude: 8.732 });
  });

  it('reads Chinese, Japanese and Korean names', () => {
    const shenzhen = { country: 'CN', name: 'Shenzhen', latitude: 22.55, longitude: 114.07 };
    expectPlace('深圳市', shenzhen);
    expectPlace('广东省深圳市', shenzhen);
    expectPlace('Zhejiang Province Jinhua City', { country: 'CN', name: 'Jinhua', latitude: 29.11, longitude: 119.64 });
    expectPlace('東京都', { country: 'JP', name: 'Tokyo', latitude: 35.69, longitude: 139.69 });
    expectPlace('서울', { country: 'KR', name: 'Seoul', latitude: 37.57, longitude: 126.98 });
  });

  it('takes a region for its country, not for a town that shares a word of its name', () => {
    expect(place('Guangdong Province')).toMatchObject({ precision: 'country', country: 'CN' });
    expect(place('Cabo Delgado Province')).toMatchObject({ precision: 'country', country: 'MZ' });
    expect(place('Morona-Santiago Province')).toMatchObject({ precision: 'country', country: 'EC' });
    expect(place('Santa Catarina', ['BR'])).toMatchObject({ precision: 'country', country: 'BR' });
    // A town named like the region it lies in is still that town.
    expect(place('Example, Moscow')).toMatchObject({ precision: 'city', country: 'RU', name: 'Moscow' });
    expectPlace('Frankfurt (Oder)', { country: 'DE', name: 'Frankfurt (Oder)', latitude: 52.35, longitude: 14.55 });
  });

  it('looks past facility words to the town', () => {
    expectPlace('Agence DPD de La Crau (283)', { country: 'FR', name: 'La Crau', latitude: 43.15, longitude: 6.07 });
    expectPlace('AGENCE PARIS', { country: 'FR', name: 'Paris', latitude: 48.85, longitude: 2.35 });
    expectPlace('Zürich-Mülligen', { country: 'CH', name: 'Zürich', latitude: 47.37, longitude: 8.55 });
    expect(place('Centre de tri DPD de Le Coudray (175)', ['FR'])).toMatchObject({ country: 'FR', name: 'Le Coudray' });
  });

  it('puts Swiss Post sorting centres on their own site', () => {
    const mulligen = { precision: 'city', country: 'CH', name: 'Zürich', site: 'Zürich-Mülligen', latitude: 47.3959, longitude: 8.4695 };
    expect(place('Zürich Briefzentrum 801050')).toEqual(mulligen);
    expect(place('Zürich Briefzentrum International 801053')).toEqual(mulligen);
    expect(place('Daillens Centre Colis 131000')).toEqual({ precision: 'city', country: 'CH', name: 'Daillens', latitude: 46.6327, longitude: 6.541 });
    // A site the table does not know stays on its town.
    expectPlace('Zürich 15 Zustellung 801500', { country: 'CH', name: 'Zürich', latitude: 47.37, longitude: 8.55 }, ['CH']);
    // The number alone is not enough: the name has to start with the site's town.
    expect(place('Basel 801050', ['CH'])).toMatchObject({ name: 'Basel' });
  });

  it('places India Post offices by their PIN code when their name is no town', () => {
    expectPlace('Example TMO 800001', { country: 'IN', name: 'Patna', latitude: 25.59, longitude: 85.14 }, ['IN']);
    // India among the parcel's countries is enough.
    expectPlace('Office - 12345678 700001', { country: 'IN', name: 'Kolkata', latitude: 22.56, longitude: 88.36 }, ['FR', 'IN']);
    expect(place('Example TMO 800001')).toBeNull();
    expect(place('Example TMO 800001', ['CH'])).toBeNull();
    // A foreign airport's code is an office of exchange abroad; 9 starts the Army Postal Service's PINs.
    for (const location of ['Office - FRA 400001', 'Office - DEFRA 400001', 'Example TMO 900056']) expect(place(location, ['IN']), location).toBeNull();
    // A town nothing confirms keeps its six digits: here a Swiss Post site.
    expect(place('Daillens Distribution 131070', ['FR', 'IN'])).toBeNull();
  });

  it('finds small Swiss towns and postcodes when the parcel is in Switzerland', () => {
    expectPlace('Härkingen 4622', { country: 'CH', name: 'Härkingen', latitude: 47.3, longitude: 7.82 }, ['CH', 'LI']);
    expectPlace('Dintikon', { country: 'CH', name: 'Dintikon', latitude: 47.36, longitude: 8.22 }, ['CH']);
    expectPlace('Buchs SG 9470', { country: 'CH', name: 'Buchs', latitude: 47.16, longitude: 9.47 }, ['CH']);
    // Unconfirmed, a hamlet's name is not enough.
    expect(place('Dintikon')).toBeNull();
  });

  it('prefers the country the parcel is in for names several countries share', () => {
    expect(place('Emmen')?.country).toBe('NL');
    expect(place('Emmen', ['CH'])?.country).toBe('CH');
    expect(place('Bienne', ['CH'])).toMatchObject({ country: 'CH' });
    expect(place('Cologne')).toMatchObject({ country: 'DE', name: 'Cologne' });
    expect(place('Genf')).toMatchObject({ country: 'CH', name: 'Genf' });
  });

  it('falls back to the country when only the country is known', () => {
    expect(place('Germany')).toMatchObject({ precision: 'country', country: 'DE', name: 'Germany' });
    expect(place('CH')).toMatchObject({ precision: 'country', country: 'CH' });
    expect(place('Example Hub, China')).toMatchObject({ precision: 'country', country: 'CN' });
    expect(place('Australia')).toMatchObject({ precision: 'country', country: 'AU', name: 'Australia', latitude: -24.13 });
  });

  it('declines text that names no place it can trust', () => {
    for (const location of [
      '', '   ', 'CENTRE DE TRI', 'Return location', 'Livré au destinataire', 'Example City', 'Home', 'Post branch',
      'Your neighbourhood', '示例市', 'FR0012', 'Maker SO 841215', 'EXAMPLE AIR HUB', 'Hub', 'CDG', 'GOFO-PR',
      // A US military post office, anywhere in its region.
      'Fpo, AE', 'APO AE', 'FPO, AP 96001',
    ]) expect(place(location), location).toBeNull();
    expect(place('Warehouse 2024', ['CH'])).toBeNull();
    expect(locatePlace(undefined)).toBeNull();
  });

  it('reads no town from a three-letter alternate name, a code more often than a name', () => {
    // GeoNames gives Lognes "Lon" and Jizhou "Chi": a British office of exchange is no French town.
    for (const location of ['LON E ET BEA', 'CHI', 'BIN']) expect(place(location), location).toBeNull();
    expect(placesForEvents(['LONDON BPI, United Kingdom', 'LON E ET BEA'])[1]).toBeNull();
    // A town's own three-letter name still places it.
    expect(place('ATH')).toMatchObject({ country: 'BE', name: 'Ath' });
  });
});

describe('placesForEvents', () => {
  it('lets a scan borrow the country of the scans around it', () => {
    const [zurich, buchs, empty] = placesForEvents(['ZUERICH, CH', 'Buchs', '  ']);
    expect(zurich?.country).toBe('CH');
    expect(buchs).toMatchObject({ country: 'CH', name: 'Buchs' });
    expect(empty).toBeNull();
    expect(placesForEvents(['Kyoto', 'Emmen', 'Leipzig'])[1]?.country).toBe('NL');
    expect(placesForEvents(['Bern', 'Emmen'])[1]?.country).toBe('CH');
  });

  it('moves every scan with the same text to a point the carrier gave for one of them', () => {
    const gpo = { latitude: 25.6036, longitude: 85.1326 };
    const places = placesForEvents(['Patna GPO 800001', 'Patna GPO 800001', 'Patna NSH 800001'], { carrierCountries: ['IN'], points: [null, gpo, null] });
    expect(places.map((found) => found && [found.latitude, found.longitude])).toEqual([[25.6036, 85.1326], [25.6036, 85.1326], [25.594, 85.136]]);
    // A point far from the town its scan names is not used.
    expect(placesForEvents(['Patna GPO 800001'], { carrierCountries: ['IN'], points: [{ latitude: 28.6448, longitude: 77.2167 }] })[0])
      .toMatchObject({ latitude: 25.594, longitude: 85.136 });
  });

  it('places the logistics sites Mondial Relay names, as the app asks for a French carrier', () => {
    const sites = ['METZ', 'HUB de Troyes', 'REIMS', 'BORDEAUX', 'TERRASSON', 'BRIVE', 'NIORT', 'REAU'];
    const places = placesForEvents(sites, { carrierCountries: ['FR'] });
    expect(places.map((found) => found && `${found.name}, ${found.country}`)).toEqual([
      'Metz, FR', 'Troyes, FR', 'Reims, FR', 'Bordeaux, FR', 'Terrasson-Lavilledieu, FR', 'Brive-la-Gaillarde, FR', 'Niort, FR', 'Réau, FR',
    ]);
    // Réau in Seine-et-Marne, by Melun.
    expect(places[7]!.latitude).toBeCloseTo(48.61, 1);
    expect(places[7]!.longitude).toBeCloseTo(2.62, 1);
  });

  it('places the towns Cainiao writes in brackets', () => {
    const places = placesForEvents(['Fenggang Town', 'Xiaoshan District', 'Compans', 'Bordeaux', 'Camblanes-et-meynac']);
    expect(places.map((found) => found && `${found.name}, ${found.country}`)).toEqual([
      'Fenggang Town, CN', 'Xiaoshan, CN', 'Compans, FR', 'Bordeaux, FR', 'Camblanes, FR',
    ]);
    expect(places[0]).toMatchObject({ latitude: 22.757, longitude: 114.149 });
  });

  it('uses the destination and the carrier before guessing', () => {
    expect(placesForEvents(['Dintikon'], { carrierCountries: ['CH', 'LI'] })[0]?.name).toBe('Dintikon');
    expect(placesForEvents(['Emmen'], { destinationCountry: 'CH' })[0]?.country).toBe('CH');
    expect(placesForEvents(['Dintikon'])[0]).toBeNull();
  });

  const route = (locations: string[], options?: Parameters<typeof placesForEvents>[1]) =>
    placesForEvents(locations, options).map((found) => found && `${found.name}, ${found.country}`);

  it("takes a carrier's countries and hubs from the catalog", () => {
    expect(route(['Dintikon'], { carriers: ['swiss-post'] })).toEqual(['Dintikon, CH']);
    // Royal Mail is British, whatever clock its scans keep: Langley by Heathrow, not Langley in Canada.
    expect(route(['Norwich MC', 'LANGLEY', 'Roissy'], { carriers: ['royal-mail'] })).toEqual(['Norwich, GB', 'Langley, GB', 'Roissy, FR']);
    expect(placesForEvents(['Rothenburg, CH', 'Buchs, CH'], { carriers: ['dpd'] })[1]).toMatchObject({ latitude: 47.452, longitude: 8.43 });
    // A carrier the catalog does not know adds nothing.
    expect(route(['Dintikon'], { carriers: ['example-carrier'] })).toEqual([null]);
  });

  it('gives a namesake far off the way of the parcel no place', () => {
    const royalMail = { carriers: ['royal-mail'] };
    // The mail centre for Cornwall is not in Cornwall, Ontario, and the next scan is not in Nova Scotia after it.
    expect(route(['Plymouth MC', 'Cornwall MC', 'Truro DO'], royalMail)).toEqual(['Plymouth, GB', null, 'Truro, GB']);
    expect(route(['FR', 'Cornwall', 'GB'])).toEqual(['France, FR', null, 'United Kingdom, GB']);
    // Where the scans stop there is no way to be off, only a distance: a name several towns share is not enough.
    expect(route(['Plymouth MC', 'Cornwall MC'], royalMail)).toEqual(['Plymouth, GB', null]);
    expect(route(['Mount Pleasant MC'], royalMail)).toEqual([null]);
    // Its own text, the destination or a scan nearby keeps the town.
    expect(route(['Plymouth MC', 'Cornwall, ON'], royalMail)).toEqual(['Plymouth, GB', 'Cornwall, CA']);
    expect(route(['Plymouth MC', 'Cornwall'], { ...royalMail, destinationCountry: 'CA' })).toEqual(['Plymouth, GB', 'Cornwall, CA']);
    expect(route(['Heathrow', 'Mississauga', 'Cornwall'], royalMail)).toEqual(['Heathrow, GB', 'Mississauga, CA', 'Cornwall, CA']);
    // So does a name no other town has, or a world city's.
    expect(route(['Xiaoshan District'], { carriers: ['ecoscooting'] })).toEqual(['Xiaoshan, CN']);
    expect(route(['Heathrow', 'Chicago'], royalMail)).toEqual(['Heathrow, GB', 'Chicago, US']);
    // A hub on the way is no detour, and a parcel nothing is known about keeps what its scans say.
    expect(route(['Shenzhen', 'Liège', 'Paris'], { carriers: ['la-poste'] })).toEqual(['Shenzhen, CN', 'Liège, BE', 'Paris, FR']);
    expect(route(['Mount Pleasant MC'])).toEqual(['Mount Pleasant, US']);
  });

  it('keeps a world city in its own country when a namesake would take it off the way', () => {
    // A Ukrainian parcel flown to the United States leaves from Warsaw and Paris, not from their American namesakes.
    for (const options of [{ destinationCountry: 'US', carriers: ['gofo', 'nova-poshta'] }, { carriers: ['nova-poshta'] }]) {
      expect(route(['Lviv', 'Warsaw', 'New York'], options)).toEqual(['Lviv, UA', 'Warsaw, PL', 'New York, US']);
      expect(route(['Lviv', 'Warsaw', 'Warsaw', 'New York'], options)).toEqual(['Lviv, UA', 'Warsaw, PL', 'Warsaw, PL', 'New York, US']);
      expect(route(['Lviv', 'Paris', 'New York'], options)).toEqual(['Lviv, UA', 'Paris, FR', 'New York, US']);
    }
    // A namesake on the way stays, and so does a town the parcel's country holds that no larger one outweighs.
    expect(route(['Dallas, TX', 'Paris', 'Memphis, TN'], { destinationCountry: 'US' })).toEqual(['Dallas, US', 'Paris, US', 'Memphis, US']);
    expect(route(['Toronto, ON', 'London', 'Windsor, ON'], { destinationCountry: 'CA' })).toEqual(['Toronto, CA', 'London, CA', 'Windsor, CA']);
    expect(route(['ORLEANS'])).toEqual(['Orléans, CA']);
    expect(route(['ORLEANS', 'Tours'], { carriers: ['yunexpress'] })).toEqual(['Orléans, FR', 'Tours, FR']);
    expect(route(['Paris', 'ORLEANS', 'Tours'], { carriers: ['yunexpress'] })).toEqual(['Paris, FR', 'Orléans, FR', 'Tours, FR']);
    expect(route(['Lausanne', 'Chavannes', 'Daillens Centre Colis'])).toEqual(['Lausanne, CH', 'Chavannes, CH', 'Daillens, CH']);
    expect(route(['CH', 'Chavannes', 'Daillens Centre Colis', 'CH'], { destinationCountry: 'CH', carriers: ['swiss-post'] }))
      .toEqual(['Switzerland, CH', 'Chavannes, CH', 'Daillens, CH', 'Switzerland, CH']);
  });

  it('gives paperwork filed away from the parcel no place', () => {
    const scans = (list: [string, string, string][]) => route(list.map(([location]) => location), {
      stages: list.map(([, stage]) => stage),
      times: list.map(([, , time]) => time),
    });
    const hongKong = 'HONG KONG - HONG KONG SAR, CHINA';
    const basel = 'BASEL - SWITZERLAND';
    // The destination's customs office clears the parcel while it is still being sorted in Hong Kong.
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00Z'], [basel, 'customs', '2026-01-05T15:53:00Z']]))
      .toEqual(['Hong Kong, HK', null]);
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00Z'], [basel, 'customs', '2026-01-05T15:53:00Z'],
      [hongKong, 'in_transit', '2026-01-05T16:18:00Z'], ['BAHRAIN - BAHRAIN', 'in_transit', '2026-01-06T08:27:00Z']]))
      .toEqual(['Hong Kong, HK', null, 'Hong Kong, HK', 'Bahrain, BH']);
    expect(route([hongKong, basel, hongKong])).toEqual(['Hong Kong, HK', 'Basel, CH', 'Hong Kong, HK']);
    // Once the parcel has had time to get there, the clearance is where it is; a clock without its offset proves nothing.
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00Z'], ['LEIPZIG - GERMANY', 'in_transit', '2026-01-06T08:00:00Z'],
      [basel, 'customs', '2026-01-06T20:00:00Z'], [basel, 'in_transit', '2026-01-06T22:00:00Z']]))
      .toEqual(['Hong Kong, HK', 'Leipzig, DE', 'Basel, CH', 'Basel, CH']);
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00'], [basel, 'customs', '2026-01-05T15:53:00']]))
      .toEqual(['Hong Kong, HK', 'Basel, CH']);
    // An import released by a central office the parcel never went to.
    expect(scans([['Barcelona, BC, ES', 'in_transit', '2026-01-05T15:51:00Z'], ['Madrid, MD, ES', 'customs', '2026-01-07T11:07:00Z'],
      ['Barcelona, BC, ES', 'in_transit', '2026-01-08T18:02:00Z']])).toEqual(['Barcelona, ES', null, 'Barcelona, ES']);
    // The delivering carrier registers the parcel, and misses it, before it has crossed.
    expect(scans([['FR', 'registered', '2026-01-05T11:09:00Z'], ['LONDON - UNITED KINGDOM', 'accepted', '2026-01-07T07:49:00Z'],
      ['FR', 'pending', '2026-01-07T11:52:00Z'], ['AMSTERDAM - NETHERLANDS', 'in_transit', '2026-01-08T07:27:00Z'],
      ['FR', 'delivered', '2026-01-10T14:32:00Z']]))
      .toEqual([null, 'London, GB', null, 'Amsterdam, NL', 'France, FR']);
    expect(scans([['Germany', 'registered', '2026-01-05T10:05:00Z'], ['Shanghai, China', 'accepted', '2026-01-05T10:05:56Z']]))
      .toEqual([null, 'Shanghai, CN']);
    // A label created where the parcel sets off stays, and so does a hub only a country names on its way.
    expect(scans([['Poland', 'registered', '2026-01-05T21:25:00Z'], ['Warsaw', 'accepted', '2026-01-07T09:00:00Z'],
      ['Berlin', 'in_transit', '2026-01-08T09:00:00Z']])).toEqual(['Poland, PL', 'Warsaw, PL', 'Berlin, DE']);
    expect(scans([['Poland', 'registered', '2026-01-05T21:25:00Z'], ['Strasbourg', 'accepted', '2026-01-07T09:00:00Z'],
      ['Berlin', 'in_transit', '2026-01-08T09:00:00Z'], ['Warsaw', 'delivered', '2026-01-09T09:00:00Z']]))
      .toEqual([null, 'Strasbourg, FR', 'Berlin, DE', 'Warsaw, PL']);
    expect(scans([['Shenzhen', 'in_transit', '2026-01-05T10:00:00Z'], ['Hong Kong International Hub', 'in_transit', '2026-01-06T21:04:00Z'],
      ['Leipzig', 'in_transit', '2026-01-07T09:00:00Z']])).toEqual(['Shenzhen, CN', 'Hong Kong, HK', 'Leipzig, DE']);
  });
});
