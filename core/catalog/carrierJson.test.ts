import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type SchemaObject } from 'ajv';
import { describe, expect, it } from 'vitest';
import { CARRIER_DEFINITIONS } from './definitions.js';

const catalogDirectory = path.dirname(fileURLToPath(import.meta.url));
const carriersDirectory = path.resolve(catalogDirectory, '..', '..', 'carriers');
const schema: SchemaObject = JSON.parse(readFileSync(path.join(catalogDirectory, 'carrier.schema.json'), 'utf8'));

const folders = readdirSync(carriersDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function readCarrier(folder: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(carriersDirectory, folder, 'carrier.json'), 'utf8'));
}

describe('carrier.json', () => {
  const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

  it('has at least one carrier folder', () => {
    expect(folders.length).toBeGreaterThan(0);
  });

  it.each(folders)('%s matches the carrier schema', (folder) => {
    const carrier = readCarrier(folder);
    const valid = validate(carrier);
    const errors = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    expect(errors ? `${folder}: ${errors}` : folder).toBe(folder);
    expect(valid).toBe(true);
  });

  it('names every carrier after its folder', () => {
    expect(folders.map((folder) => readCarrier(folder).id)).toEqual(folders);
  });

  it('keeps detection rule ids unique across the catalog', () => {
    const ids = folders.flatMap((folder) => {
      const detection = readCarrier(folder).detection as Array<{ id: string }>;
      return detection.map((rule) => rule.id);
    });
    expect([...new Set(ids)]).toHaveLength(ids.length);
  });

  it('says a carrier gives day-only scans by design only where its adapter keeps local clocks', () => {
    const tracking = (folder: string) => readCarrier(folder).tracking as { localClocks?: boolean; dateOnlyScans?: boolean };
    const dayOnly = folders.filter((folder) => tracking(folder).dateOnlyScans);
    expect(dayOnly).toContain('brt');
    expect(dayOnly.filter((folder) => !tracking(folder).localClocks)).toEqual([]);
  });

  it("says which carriers' pages state every scan on a clock of their own, and the catalog carries it", () => {
    const pageClocks = folders.filter((folder) => (readCarrier(folder).tracking as { pageClock?: boolean }).pageClock);
    expect(pageClocks).toEqual(['landmark-global']);
    expect(CARRIER_DEFINITIONS['landmark-global'].tracking.pageClock).toBe(true);
    expect(CARRIER_DEFINITIONS['dhl-express'].tracking).not.toHaveProperty('pageClock');
  });

  it('flags local clocks wherever an adapter writes a scan without an instant', () => {
    // These normally give instants, retaining an occasional day or offset-less clock. The flag
    // would hold their answers back for a provider's dated copy, as it did Hualei trackers in gzyl.
    const unflagged = ['dpd', 'fan-courier-international', 'fedex', 'guatex', 'gzyl', 'la-poste', 'shipter', 'ups', 'usps', 'yanwen'];
    const writes = (folder: string) => readdirSync(path.join(carriersDirectory, folder))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .some((file) => /[{ ,]local_time:/.test(readFileSync(path.join(carriersDirectory, folder, file), 'utf8')));
    const tracking = (folder: string) => readCarrier(folder).tracking as { localClocks?: boolean };
    expect(folders.filter((folder) => writes(folder) && !tracking(folder).localClocks)).toEqual(unflagged);
  });
});
