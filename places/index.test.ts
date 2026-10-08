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
    // Mondial Relay's agency in Terrasson-Lavilledieu, under the town's short name.
    expect(place('TERRASSON', ['FR'])).toEqual({ precision: 'city', country: 'FR', name: 'Terrasson-Lavilledieu', latitude: 45.129, longitude: 1.32 });
    expect(place('Agence de Terrasson')).toMatchObject({ country: 'FR', latitude: 45.129, longitude: 1.32 });
    // A longer name that contains a hub's is that place.
    expect(place('Terrasson-Lavilledieu', ['FR'])).toMatchObject({ country: 'FR', name: 'Terrasson-Lavilledieu' });
    expect(place('Terrasson-Lavilledieu', ['FR'])!.longitude).toBeCloseTo(1.3, 2);
    expect(place('BEAUREGARD DE TERRASSON', ['FR'])).toMatchObject({ country: 'FR', name: 'Beauregard-de-Terrasson' });
    expect(place('Beauregard-de-Terrasson')).toBeNull();
    expect(place('Roissy-en-Brie')).toMatchObject({ country: 'FR', name: 'Roissy-en-Brie' });
    // A country or a region in the text names no airport.
    for (const location of ['Cuernavaca, Mexico', 'HSINCHU - TAIWAN', 'Soyapango, San Salvador']) expect(place(location)?.site, location).toBeUndefined();
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
      'Your neighbourhood', '示例市', 'FR0012', 'Maker SO 841215', 'EXAMPLE AIR HUB', 'Hub', 'CDG',
    ]) expect(place(location), location).toBeNull();
    expect(place('Warehouse 2024', ['CH'])).toBeNull();
    expect(locatePlace(undefined)).toBeNull();
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
});
