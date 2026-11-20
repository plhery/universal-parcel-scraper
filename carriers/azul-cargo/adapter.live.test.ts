import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { AzulCargoTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.AZUL_CARGO_TRACKING_NUMBER;
const unknown = process.env.AZUL_CARGO_UNKNOWN_NUMBER;

describe('Azul Cargo Express live public tracking', () => {
  it.skipIf(!trawl || !number)('reads the requested history on wall clocks', async () => {
    const result = await new AzulCargoTracker({ trawl }).fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)) && !event.time)).toBe(true);
  }, 60_000);
  it.skipIf(!trawl || !unknown)('reports an unknown AWB', async () => {
    await expect(new AzulCargoTracker({ trawl }).fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
