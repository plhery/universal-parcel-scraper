import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CtlGroupTracker, ctlGroupTrackingUrl, normalizeCtlGroupNumber, parseCtlGroup } from './adapter.js';
import { ctlGroupStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const unknown = fixture('not-found');
const NUMBER = numbers.records[1]!.number;
const UNKNOWN = '00000000';
// The last scan's row, which the edits below replace.
const LAST_ROW = /<tr>\s*<td>2020-11-19 01:54:11<\/td>[\s\S]*?<\/tr>/;
const withLastRow = (cells: string) => delivered.replace(LAST_ROW, `<tr>${cells}</tr>`);

type Answer = { status?: number; body?: string; headers?: Record<string, string> };
function harness(answer: Answer | Answer[] = { body: delivered }) {
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return new Response(next.body ?? '', { status: next.status ?? 200, headers: { 'content-type': 'text/html; charset=UTF-8', ...next.headers } });
  });
  return { fetcher, tracker: new CtlGroupTracker({ fetcher, recorder: NOOP_RECORDER }) };
}

describe('CTL Group tracker', () => {
  it('reads the help page’s waybill: entered, collected at Kożuchów, through Poznań, delivered at Kępno', () => {
    const result = parseCtlGroup(delivered, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'doręczona', last_update: null, last_update_local: '2020-11-19T01:54:11', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(7);
    expect(result.events![0]).toEqual({ local_time: '2020-11-19T01:54:11', description: 'doręczona', location: 'Kępno',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2020-11-16T17:54:53', description: 'wprowadzona do systemu',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.map((event) => event.stage)).toEqual(['delivered', 'in_transit', 'in_transit', 'out_for_delivery',
      'accepted', 'registered', 'registered']);
    expect(result.events![1]).toMatchObject({ location: 'Baza 2 - Poznań' });
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('keeps a scan it cannot stage, each scan once, and never the name of who took the shipment', () => {
    // Invented: a scan in words the map does not know, the delivery repeated, and the signatory line.
    const page = delivered.replace('</table>', `<tr><td>2020-11-19 01:54:11</td><td>Kępno</td><td><strong>doręczona</strong></td></tr>
      <tr><td>2020-11-19 08:00:00</td><td>Kępno</td><td><strong>dokumenty zwrotne</strong></td></tr></table>
      <p>Przesyłka odebrana przez: <strong>Recipient Name</strong></p>`);
    const result = parseCtlGroup(page, NUMBER);
    expect(result.events).toHaveLength(8);
    expect(result.events![0]).toEqual({ local_time: '2020-11-19T08:00:00', description: 'dokumenty zwrotne', location: 'Kępno' });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'dokumenty zwrotne' });
    expect(JSON.stringify(result)).not.toContain('Recipient Name');
  });

  it('answers only for the waybill asked', () => {
    expect(() => parseCtlGroup(unknown, UNKNOWN)).toThrow(NotFoundError);
    expect(() => parseCtlGroup(unknown, NUMBER)).toThrow(IndeterminateError);
    expect(() => parseCtlGroup(delivered, UNKNOWN)).toThrow(IndeterminateError);
  });

  it('refuses a page it cannot read', () => {
    expect(() => parseCtlGroup('<html><body>maintenance</body></html>', NUMBER)).toThrow(SchemaError);
    expect(() => parseCtlGroup(unknown.replace('Brak zamówienia', 'Błąd serwera'), UNKNOWN)).toThrow(SchemaError);
    expect(() => parseCtlGroup(delivered.replace('<th>Miejsce</th>', '<th>Oddział</th>'), NUMBER)).toThrow(SchemaError);
    for (const cells of ['<td>19.11.2020 01:54</td><td>Kępno</td><td>doręczona</td>', '<td>2020-02-30 01:54:11</td><td></td><td>doręczona</td>',
      '<td>1999-11-19 01:54:11</td><td></td><td>doręczona</td>', '<td>2020-11-19 01:54:11</td><td>Kępno</td><td> </td>',
      '<td>2020-11-19 01:54:11</td><td>doręczona</td>']) {
      expect(() => parseCtlGroup(withLastRow(cells), NUMBER), cells).toThrow(SchemaError);
    }
    const empty = delivered.replace(/<tr>\s*<td>[\s\S]*?<\/tr>/g, '');
    expect(() => parseCtlGroup(empty, NUMBER)).toThrow(NoHistoryError);
    expect(() => parseCtlGroup('<html><title>Just a moment...</title></html>', NUMBER)).toThrow(ChallengeError);
    expect(() => parseCtlGroup(`<div class="cf-turnstile"></div>${delivered}`, NUMBER)).toThrow(ChallengeError);
  });

  it('takes a waybill number in digits and refuses anything else before asking', async () => {
    expect(normalizeCtlGroupNumber(` ${NUMBER.slice(0, 4)} ${NUMBER.slice(4)} `)).toBe(NUMBER);
    const h = harness();
    for (const number of ['12345', '1234567890123', 'CTL20130', '2013-0401', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('ctl-group-pl');
  });

  it('opens the tracking page for the waybill', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([ctlGroupTrackingUrl(NUMBER)]);
    expect(ctlGroupTrackingUrl(UNKNOWN)).toBe('https://www.ctlgroup.pl/tracking/00000000');
    expect(h.fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null, fetcher: h.fetcher }))
      .toMatchObject({ id: 'ctl-group-pl', steps: ['direct', 'retry'] });
  });

  it('reads each answer as what it is', async () => {
    await expect(harness({ body: unknown }).tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness({ status: 403, body: '' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ status: 429, body: '', headers: { 'retry-after': '60' } }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(harness({ status: 404, body: '' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness({ status: 302, body: '', headers: { location: '/' } }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness({ body: '<html><title>Just a moment...</title></html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ body: '<html>maintenance</html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('maps every scan wording it has seen or the tracker names', () => {
    for (const entry of statuses.entries) {
      expect(ctlGroupStage(entry.wording.toUpperCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ctl-group-pl', description: entry.wording }), entry.wording)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
  });
});
