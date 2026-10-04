import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NovaPoshtaTracker } from './adapter.js';
import { parseNovaPoshta } from './parser.js';
const NUMBER = '59000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('Nova Poshta summary parser', () => {
  it('retains a receipt summary without inventing movement history', () => {
    const result = parseNovaPoshta(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', summary_only: true,
      delivered_at: '2026-01-03T12:00:00+02:00', last_update: '2026-01-03T12:00:00+02:00', events: [] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
  });
  it('does not date transit from booking or metadata refresh', () => {
    const value = fixture(); value.data[0].StatusCode = '5'; value.data[0].Status = 'In transit';
    expect(parseNovaPoshta(value, NUMBER)).toMatchObject({ status: 'in_transit', last_update: null, events: [] });
    expect(parseNovaPoshta(value, NUMBER).delivered_at).toBeUndefined();
  });
  it('preserves unknown codes and invalid receipt clocks', () => {
    const value = fixture(); value.data[0].StatusCode = 'NEW';
    const result = parseNovaPoshta(value, NUMBER); expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
    value.data[0].StatusCode = '9'; value.data[0].RecipientDateTime = '30-02-2026 12:00:00';
    expect(parseNovaPoshta(value, NUMBER).delivered_at).toBeUndefined();
  });
  it('accepts only the identity-bound official not-found code', () => {
    const value = fixture(); value.data[0].StatusCode = '3';
    expect(() => parseNovaPoshta(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    value.data[0].Number = '59000000000002';
    expect(() => parseNovaPoshta(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('rejects ambiguous identities, malformed status and API failures', () => {
    const duplicate = fixture(); duplicate.data.push(duplicate.data[0]);
    expect(() => parseNovaPoshta(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const missing = fixture(); missing.data[0].Status = {};
    expect(() => parseNovaPoshta(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const error = fixture(); error.errors = ['Service error'];
    expect(() => parseNovaPoshta(error, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});
describe('Nova Poshta retrieval', () => {
  it('requests anonymous status with no API key or recipient phone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await new NovaPoshtaTracker({ fetcher }).fetch(NUMBER);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.novaposhta.ua/v2.0/json/');
    expect(JSON.parse(init!.body as string)).toEqual({ modelName: 'TrackingDocument', calledMethod: 'getStatusDocuments',
      methodProperties: { Documents: [{ DocumentNumber: NUMBER, Phone: '' }], Language: 'EN' }, system: 'Tracking' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects cross-border input and cancellation before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new NovaPoshtaTracker({ fetcher }).fetch('NP00000000000001')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new NovaPoshtaTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
