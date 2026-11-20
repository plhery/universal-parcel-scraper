import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import booked from './fixtures/booking.json' with { type: 'json' };
import missing from './fixtures/not-found.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = booked.items[0]!.numeroDocumento;

it('restores the carrier’s waybill spelling and reports the historical reservation', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(booked));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('sunrise-logistics-colombia', number) });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://tracking-api.sunriselg.com/api/v1/seguimiento-embarques-aereo/numDoc/BOG-110491?page=1&pageSize=50',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toEqual({ status: 'unknown', last_status_text: 'CONFIRMACION DE RESERVA', summary_only: true });
});

it('uses actual movement clocks and carrier-marked current rows when supplied', () => {
  const row = booked.items[0]!;
  const recorded = { ...row, vigente: true, fechaSeguimiento: '2026-01-15T09:45:00' };
  const result = parseTracking([recorded], number);

  expect(result).toMatchObject({
    current_stage: 'registered', last_update_local: '2026-01-15T09:45:00',
    events: [{ stage: 'registered', local_time: '2026-01-15T09:45:00', written_at: '2026-01-15T14:45:21Z' }],
  });
  expect(() => parseTracking([recorded], 'OTHER-REFERENCE')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('recognizes the carrier’s exact missing air waybill reply', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(missing, { status: 404 }));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: 'DO-2025-0087' })).rejects.toMatchObject({ kind: 'not_found' });
});
