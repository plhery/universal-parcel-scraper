import { inflateSync } from 'node:zlib';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { decodeText } from '../../core/transport/index.js';
import { scanStages, traceLabels } from './status.js';

export const provider = 'cotaxi';

interface PrintedText {
  x: number;
  y: number;
  value: string;
}

function readTrackingPage(bytes: Uint8Array, pdf: string): PrintedText[] {
  const page = pdf.match(/^\d+ 0 obj\s*<<\s*\/Type \/Page\b([\s\S]*?)^endobj/m)?.[1];
  const contentId = page?.match(/\/Contents (\d+) 0 R\b/)?.[1];
  if (!contentId) throw new SchemaError(provider, 'COTAXI omitted its tracking page content');

  const stream = new RegExp('^' + contentId + ' 0 obj\\s*<<([^<>]{1,240})>>\\s*stream\\r?\\n', 'm').exec(pdf);
  const metadata = stream?.[1] ?? '';
  const size = Number(metadata.match(/\/Length (\d+)(?=\s|$)/)?.[1]);
  if (!stream || !/\/Filter \/FlateDecode\b/.test(metadata) || !Number.isSafeInteger(size) || size <= 0) {
    throw new SchemaError(provider, 'COTAXI changed the format of its tracking page content');
  }

  const start = stream.index + stream[0].length;
  if (start + size > bytes.length) throw new SchemaError(provider, 'COTAXI returned a truncated tracking page');
  let content: string;
  try {
    content = new TextDecoder('windows-1252').decode(inflateSync(bytes.subarray(start, start + size), { maxOutputLength: 128_000 }));
  } catch {
    throw new SchemaError(provider, 'COTAXI returned invalid compressed page content');
  }
  return Array.from(content.matchAll(/\bBT\s+([\d.]+)\s+([\d.]+)\s+Td\s+\(((?:\\[^\r\n]|[^\\()\r\n])*)\)\s+Tj\s+ET/g), match => ({
    x: Number(match[1]),
    y: Number(match[2]),
    value: (match[3] ?? '').replace(/\\([\\()])/g, '$1').trim(),
  }));
}

export function parseTracking(bytes: Uint8Array, number: string): CarrierResult {
  const pdf = Buffer.from(bytes).toString('latin1');
  if (!pdf.startsWith('%PDF-')) {
    const text = decodeText(bytes).trim();
    if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(text)) {
      throw new ChallengeError(provider, 'COTAXI requires verification');
    }
    if (text === 'No se encontro Remesa con ese numero 1!!!') throw new NotFoundError(provider);
    throw new SchemaError(provider, 'COTAXI did not return a tracking PDF');
  }
  const texts = readTrackingPage(bytes, pdf);
  const guideLabel = texts.find(item => item.value === 'NUMERO GUIA');
  const guide = guideLabel && texts.find(item => item.y === guideLabel.y && item.x > guideLabel.x);
  if (!guide) throw new SchemaError(provider, 'COTAXI did not print the guide number');
  if (guide.value !== number) throw new IndeterminateError(provider, 'COTAXI returned a different guide');
  if (!texts.some(item => item.value === 'TRAZABILIDAD')) {
    throw new SchemaError(provider, 'COTAXI omitted the traceability panel');
  }

  const events: CarrierEvent[] = [];
  for (const label of texts) {
    const description = label.value.replace(/\s*:\s*$/, '');
    if (!traceLabels.has(description)) continue;
    const clock = texts.find(item => item.x === label.x && label.y - item.y > 0 && label.y - item.y < 30);
    if (!clock) continue;
    const timestamp = DateTime.fromFormat(clock.value, 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    if (!timestamp.isValid) throw new SchemaError(provider, 'COTAXI returned an invalid movement clock');
    const stage = scanStages.get(description);
    events.push({
      description, local_time: timestamp.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  events.reverse().sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'COTAXI printed the guide without dated stages', { reason: 'listed' });
  const stage = scanStages.get(latest.description ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
