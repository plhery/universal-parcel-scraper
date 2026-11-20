import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { rosaliaStage } from './status.js';

const carrier = 'rosalia-express';

function checkChallenge(text: string): void {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Rosalia Express returned a browser check');
  }
}

export function readGuestForm(html: string) {
  checkChallenge(html);
  const $ = load(html);
  const form = $('div').filter((_, element) => {
    const node = $(element);
    return typeof node.attr('wire:initial-data') === 'string'
      && node.find('form').toArray().some(el => $(el).attr('wire:submit.prevent') === 'checkReceipts');
  });
  const raw = form.attr('wire:initial-data');
  const token = /\bwindow\.livewire_token\s*=\s*['"]([A-Za-z0-9]{40})['"]/.exec(html)?.[1];
  if (form.length !== 1 || !raw || !token) throw new SchemaError(carrier, 'Rosalia Express changed its guest form');

  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new SchemaError(carrier, 'Rosalia Express returned invalid guest form state');
  }
  if (!isRecord(state) || !isRecord(state.fingerprint) || state.fingerprint.name !== 'front::float-card.tracking'
    || state.fingerprint.path !== 'cek-paket' || state.fingerprint.method !== 'GET'
    || !isRecord(state.serverMemo) || typeof state.serverMemo.checksum !== 'string') {
    throw new SchemaError(carrier, 'Rosalia Express changed its guest component');
  }
  return { token, fingerprint: state.fingerprint, serverMemo: state.serverMemo };
}

export function parseTracking(text: string, number: string): CarrierResult {
  checkChallenge(text);
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'Rosalia Express returned invalid tracking JSON');
  }
  if (!isRecord(reply) || !isRecord(reply.serverMemo) || !isRecord(reply.serverMemo.data)) {
    throw new SchemaError(carrier, 'Rosalia Express changed its tracking response');
  }
  const { data } = reply.serverMemo;
  if (data.receipt !== number) throw new IndeterminateError(carrier, 'Rosalia Express returned a different receipt');
  const errors = reply.serverMemo.errors;
  if (isRecord(errors) && Array.isArray(errors.receipt)
    && errors.receipt.some((message: unknown) => message === 'No. Surat pengiriman maks. 12 karakter.'
      || message === 'Format tidak sesuai, No. SP hanya diperbolehkan angka.')) {
    throw new InvalidInputError(carrier, 'Rosalia Express rejected the shipment number format');
  }
  const rows = data.receiptResult;
  if (!Array.isArray(rows) || !rows.length) {
    throw new IndeterminateError(carrier, 'Rosalia Express supplied no receipt history');
  }
  if (rows.length > 500) throw new SchemaError(carrier, 'Rosalia Express returned too many tracking rows');
  const events = (rows as unknown[]).map((row): CarrierEvent => {
    if (!isRecord(row)) throw new SchemaError(carrier, 'Rosalia Express changed its tracking row');
    const code = clean(row.proses, 100);
    const stamp = clean(row.waktu, 55);
    const date = DateTime.fromFormat(stamp, 'ccc d, MMM yyyy. HH:mm:ss', { locale: 'id', zone: 'UTC' });
    if (!code || !date.isValid) throw new SchemaError(carrier, 'Rosalia Express changed its status or scan time');
    const note = clean(row.keterangan, 180);
    const delivery = 'Paket dalam proses delivery oleh agen';
    const description = note.startsWith(delivery) ? delivery : code;
    const stage = rosaliaStage(code, description);
    const location = clean(row.posisi, 100);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description, provider_code: code,
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
      ...(/^\([A-Z ]{2,38}\) [A-Z -]{2,64}$/.test(location) && { location }),
    };
  }).reverse().sort((left, right) => right.local_time!.localeCompare(left.local_time!));

  const latest = events[0]!;
  const stage = rosaliaStage(latest.provider_code, latest.description!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    provider_code: latest.provider_code, last_status_text: latest.description,
    last_update: null, last_update_local: latest.local_time, expected_delivery: null,
    events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
  };
}
