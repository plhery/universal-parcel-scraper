import { load } from 'cheerio';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { classifyNacexStatus, isNacexMovement, isNacexNotice } from './status.js';

const NO_HISTORY = 'No existe ningún albarán introducido en el sistema cumpliendo los criterios especificados. Consulte con su agencia NACEX más cercana.';

export function normalizeNacexNumber(raw: string): string {
  const number = raw.replace(/\s/g, '');
  if (!/^\d{4}\/\d{8}$/.test(number)) throw new InvalidInputError('NACEX', 'NACEX requires an agency and eight-digit shipment number');
  return number;
}

export function validateNacexBootstrap(html: string): void {
  const $ = load(html);
  const form = $('form[name="seguimientoFormulario"]');
  let action: URL;
  try { action = new URL(form.attr('action') ?? '', 'https://www.nacex.es'); }
  catch { throw new SchemaError('NACEX', 'NACEX tracking form changed'); }
  if (form.length !== 1 || form.attr('method')?.toLowerCase() !== 'post'
    || action.origin !== 'https://www.nacex.es' || action.search || action.hash
    || action.pathname.replace(/;jsessionid=[A-Za-z0-9._:-]{1,256}$/, '') !== '/seguimientoFormulario.do'
    || form.find('input[name="agencia_origen"]').length !== 1
    || form.find('input[name="numero_albaran"]').length !== 1) {
    throw new SchemaError('NACEX', 'NACEX tracking form changed');
  }
}

export function parseNacex(html: string, raw: string): CarrierResult {
  const number = normalizeNacexNumber(raw);
  const [agency, albaran] = number.split('/');
  const $ = load(html);
  const summary = $('#tabla_estado');
  const history = $('#table_historico');
  if (!summary.length && !history.length) {
    const negative = $('.Z3 .t9').clone();
    negative.find('br').replaceWith(' ');
    // This is a scoped result of the submitted anonymous form, not a generic
    // HTTP error or a hidden no-results message in the initial form.
    if ($('.Z3 h2').length === 1 && clean($('.Z3 h2').text(), 80) === 'Formulario de Seguimiento'
      && negative.length === 1 && clean(negative.text(), 300) === NO_HISTORY) {
      throw new NotFoundError('NACEX');
    }
    throw new IndeterminateError('NACEX', 'NACEX did not return shipment history');
  }
  if (summary.length !== 1 || history.length !== 1) throw new SchemaError('NACEX', 'NACEX returned ambiguous shipment history');
  const summaryRows = summary.find('tr');
  const identity = summaryRows.eq(0).children('td');
  const statusCells = summaryRows.eq(1).children('td');
  if (identity.length !== 2 || clean(identity.eq(0).text(), 40) !== 'Envío:' || clean(identity.eq(1).text(), 40) !== number
    || statusCells.length !== 2 || clean(statusCells.eq(0).text(), 40) !== 'Estado:') {
    throw new SchemaError('NACEX', 'NACEX returned a different or incomplete shipment');
  }
  const metadata = $('#capa_detalle_no_loginado .fuente_label');
  for (const [label, expected] of [['Agencia origen', agency], ['Nº Albarán', albaran]]) {
    const values = metadata.filter((_, node) => clean($(node).text(), 40) === label).map((_, node) => {
      const parent = $(node).parent().clone();
      parent.children().remove();
      return clean(parent.text(), 40);
    }).get();
    if (!values.length || values.length > 2 || values.some(value => value !== expected)) {
      throw new SchemaError('NACEX', 'NACEX returned a different or ambiguous shipment detail');
    }
  }
  const summaryLabel = clean(statusCells.eq(1).text(), 120);
  if (!summaryLabel || !/^[\p{L}][\p{L}\s().-]{1,119}$/u.test(summaryLabel)) throw new SchemaError('NACEX', 'NACEX returned an invalid current status');
  const rows = history.find('tr');
  if (!rows.length) throw new IndeterminateError('NACEX', 'NACEX returned empty shipment history');
  if (rows.length > 500) throw new SchemaError('NACEX', 'NACEX returned too many scans');
  const scans: { event: CarrierEvent; mapped?: ClassifiedStatus; notice: boolean }[] = [];
  let dayText = '';
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 1) throw new SchemaError('NACEX', 'NACEX history columns changed');
    const cell = cells.eq(0);
    if (cell.hasClass('sg_hist_fecha')) {
      if (cell.attr('colspan') !== '2') throw new SchemaError('NACEX', 'NACEX history date layout changed');
      dayText = clean(cell.text(), 64);
      continue;
    }
    if (!cell.hasClass('sg_hist_desc')) throw new SchemaError('NACEX', 'NACEX history scan layout changed');
    const labels = cell.children('b, font.fuente_titulo_green');
    // Comments, signatures and contact instructions follow this label as
    // separate text nodes. A parenthetical agency or pickup point is routing
    // detail, not code.
    const label = clean(labels.text(), 160).replace(/\s*\(\d{4}(?:-\d{1,3})?\)$/, '');
    if (labels.length !== 1 || !/^[\p{L}][\p{L}\s.-]{1,119}$/u.test(label)) {
      throw new SchemaError('NACEX', 'NACEX returned an invalid scan label');
    }
    const mapped = classifyNacexStatus(label);
    const trailing = clean(cell.contents().filter((_, node) => node.nodeType === 3).map((_, node) => $(node).text()).get().join(' '), 300);
    // The same trailing column holds a recipient after delivery. Only the
    // observed depot/locality shape of a movement scan is a location.
    const locality = isNacexMovement(label) && /^\d{4}(?:-\d{1,3})?\s*-\s*([\p{L}][\p{L}\s.()-]{1,99})$/u.exec(trailing)?.[1];
    scans.push({ mapped, notice: isNacexNotice(label), event: { description: mapped?.status === 'delivered' ? 'Delivered' : label,
      provider_status: label, ...(dayText ? { provider_time_text: dayText } : {}), ...(locality ? { location: locality } : {}) } });
  }
  // Rows run newest first. A notice keeps the stage of the scan before it.
  let previous: ClassifiedStatus | undefined;
  const applied = new Map<CarrierEvent, ClassifiedStatus>();
  for (const scan of [...scans].reverse()) {
    if (scan.notice && previous) {
      applied.set(scan.event, previous);
      Object.assign(scan.event, { stage: previous.stage, stage_source: 'none' });
    } else if (scan.mapped) {
      previous = scan.mapped;
      applied.set(scan.event, scan.mapped);
      scan.event.stage = scan.mapped.stage;
    }
  }
  const events = scans.map(scan => scan.event);
  if (!events.length || !events.some(event => event.stage)) throw new IndeterminateError('NACEX', 'NACEX returned no actual tracking scans');
  // Calendar headings have no scan clock or zone. Preserve provider order,
  // including same-day repeated scans, without inventing midnight instants.
  const mapped = classifyNacexStatus(summaryLabel);
  const current = isNacexNotice(summaryLabel) ? applied.get(events[0]!) ?? mapped : mapped;
  const latestPhysical = scans.find(scan => scan.mapped && !scan.notice);
  if (mapped?.stage === 'delivered' && latestPhysical?.mapped?.stage !== 'delivered') {
    throw new SchemaError('NACEX', 'NACEX current status contradicts its latest shipment scan');
  }
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: mapped?.status === 'delivered' ? 'Delivered' : summaryLabel,
    last_update: null, events: events.slice(0, 100) };
}
