import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, AzulCargoTracker, azulCargoTrackingUrl, normalizeAzulCargoNumber, parseAzulCargo } from './adapter.js';

// Synthetic AWB, names and terminals, laid out as the tracker's share link renders a card.
const NUMBER = '12345678';
const NOW = Date.parse('2026-11-20T03:00:00Z');

type Scan = { clock: string; title: string; lines?: string[] };
const DELIVERED: Scan[] = [
  { clock: '14 de novembro - 17:13', title: 'Encomenda entregue no destino ', lines: ['Recebido por: EXEMPLO DESTINATARIO ', 'Terminal de cargas Recife/PE - REC '] },
  { clock: '14 de novembro - 13:11', title: 'Base de Destino, Terminal de cargas Recife/PE - REC ' },
  { clock: '14 de novembro - 09:41', title: 'Saída do voo , Terminal de cargas Viracopos/SP - VCP ' },
  { clock: '14 de novembro - 09:41', title: 'Deixou a unidade Azul Cargo Express , Terminal de cargas Viracopos/SP - VCP ' },
  { clock: '13 de novembro - 19:52', title: 'Chegada do voo , Terminal de cargas Viracopos/SP - VCP ' },
  { clock: '13 de novembro - 13:00', title: 'Saída do voo , Terminal de cargas Campo Grande/MS - CGR ' },
  { clock: '13 de novembro - 12:44', title: 'Encomenda enviada , Terminal de cargas Campo Grande/MS - CGR ' },
];

function scan({ clock, title, lines = [] }: Scan): string {
  return `<div class="cardDetalhado sucesso"><div class="dataStatus"><p>${clock}</p></div><div class="descricaoStatus">
    <p class="tituloDescricao">${title}</p><p class="d-block d-md-none">${clock}</p>${lines.map(line => `<p>${line}</p>`).join('')}
    <p>Volume(s): 1/1</p><div class="circuloStatus circuloStatusPequeno"></div></div></div>`;
}

function heading(name: string): string {
  return `<div class="cardDetalhado titulo sucesso"><div class="dataStatus"></div><div class="descricaoStatus"><p class="tituloDescricao">${name}</p></div></div>`;
}

function card(options: { id?: string; status?: string; due?: string; scans?: Scan[] } = {}): string {
  const scans = options.scans ?? DELIVERED;
  const status = options.status ?? 'Entrega Realizada';
  // The reversed list repeats the scans without their terminals, oldest first; it is not read.
  return `<div class="cardRastreio bg-light status-6" id="${options.id ?? NUMBER}"><div class="resumido">
    <div class="header d-none d-md-flex"><p class="previsaoEntrega">Entrega até: <span>${options.due ?? '19/11/2026'}</span></p>
    <p class="tipoEntrega"><span>ECOMM</span> - Envio Doméstico</p></div>
    <div class="detalhado" style="display: none;"><div class="dadosDetalhados detalhadoNormal">${heading(status)}${scans.map(scan).join('')}${heading('Preparação')}</div>
    <div class="dadosDetalhados detalhadoInvertido">${heading('Preparação')}${[...scans].reverse().map(row => scan({ clock: row.clock, title: row.title.split(',')[0]! })).join('')}</div></div>
    <div class="rodape"><div class="infosRodape exibir">
      <div class="grupo"><p class="labelDados">Tipo de entrega</p><p class="dados">Retirada</p></div>
      <div class="grupo grupoAWB"><p class="labelDados">Código de rastreio (AWB)</p><p class="dados">${options.id ?? NUMBER}</p></div>
      <div class="grupo"><p class="labelDados">Peso (Kg)</p><p class="dados">15,00</p></div>
      <div class="grupo grupoUltimoStatus"><p class="labelDados">Último Status</p><p class="dados">${status}</p></div>
    </div></div></div></div>`;
}

const missing = (codes: string) => `<p>0 encomenda encontrada</p><div class="mensagem" style="font-size: 12pt"> <span>Nenhum rastreio encontrado para o(s) seguinte(s) Código(s): </span><strong>${codes}</strong> </div>`;
const page = (body: string) => `<html><head><title>Azul Logística - Rastrear</title></head><body><p>Rastreio da encomenda</p>${body}</body></html>`;

describe('Azul Cargo Express tracking page', () => {
  it('reads the full history on terminal wall clocks, newest first, with who took the parcel', () => {
    const result = parseAzulCargo(page(card()), NUMBER, NOW);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entrega Realizada', last_update: null, last_update_local: '2026-11-14T17:13:00', expected_delivery: null,
      service_name: 'ECOMM', weight_kg: 15, signed_by: 'EXEMPLO DESTINATARIO' });
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-11-14T17:13:00', 'Encomenda entregue no destino', 'Recife, PE', 'delivered'],
      ['2026-11-14T13:11:00', 'Base de Destino', 'Recife, PE', 'in_transit'],
      ['2026-11-14T09:41:00', 'Saída do voo', 'Viracopos, SP', 'in_transit'],
      ['2026-11-14T09:41:00', 'Deixou a unidade Azul Cargo Express', 'Viracopos, SP', 'in_transit'],
      ['2026-11-13T19:52:00', 'Chegada do voo', 'Viracopos, SP', 'in_transit'],
      ['2026-11-13T13:00:00', 'Saída do voo', 'Campo Grande, MS', 'in_transit'],
      ['2026-11-13T12:44:00', 'Encomenda enviada', 'Campo Grande, MS', 'accepted'],
    ]);
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain('EXEMPLO');
  });

  it('keeps the phase as the current stage and the forecast while the parcel travels', () => {
    const result = parseAzulCargo(page(card({ status: 'Disponível para Retirada', scans: DELIVERED.slice(1) })), NUMBER, NOW);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', expected_delivery: '2026-11-19',
      last_update_local: '2026-11-14T13:11:00' });
    expect(result.signed_by).toBeUndefined();
  });

  it('dates December scans read in January in the year before', () => {
    const scans = [{ clock: '2 de janeiro - 08:05', title: 'Chegada do voo , Terminal de cargas Manaus/AM - MAO' },
      { clock: '31 de dezembro - 22:10', title: 'Encomenda enviada , Terminal de cargas Recife/PE - REC' }];
    const result = parseAzulCargo(page(card({ status: 'Trânsito', scans })), NUMBER, Date.parse('2027-01-02T15:00:00Z'));
    expect(result.events?.map(event => [event.local_time, event.location])).toEqual([['2027-01-02T08:05:00', 'Manaus, AM'], ['2026-12-31T22:10:00', 'Recife, PE']]);
  });

  it('reports a missing AWB, a refusal, another AWB and an unreadable clock apart', () => {
    expect(() => parseAzulCargo(page(missing(NUMBER)), NUMBER, NOW))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAzulCargo('<html><head><title>Access Denied</title></head><body>Reference #18.1</body></html>', NUMBER, NOW))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseAzulCargo(page(card({ id: '87654321' })), NUMBER, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAzulCargo(page(missing('87654321')), NUMBER, NOW))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAzulCargo(page(card({ scans: [{ clock: '14/11 17:13', title: 'Encomenda enviada' }] })), NUMBER, NOW))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAzulCargo(page(card({ scans: [] })), NUMBER, NOW)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('takes eight or eleven digits, and the serial of a 577-prefixed AWB', () => {
    expect(normalizeAzulCargoNumber('5771234-5678')).toBe('12345678');
    expect(normalizeAzulCargoNumber('900 1234 5678')).toBe('90012345678');
    expect(azulCargoTrackingUrl(NUMBER)).toBe(`https://www.azullogistica.com.br/Rastreio/Rastrear?awb=${NUMBER}`);
    for (const number of ['1234567', '123456789', '1234567890', 'ABC12345']) {
      expect(() => normalizeAzulCargoNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('uses the supplied browser transport, cancellation signal and remaining budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ url: azulCargoTrackingUrl(NUMBER), html: page(card()), tier: 3, statusCode: 200 })));
    const made = adapter({ trawl: new TrawlClient('https://trawl.invalid'), browserExecutablePath: null, fetcher, recorder: NOOP_RECORDER, env: {} });
    await expect(made.track({ number: NUMBER }, { budgetMs: 12_000 })).resolves.toMatchObject({ status: 'delivered' });
    const [address, init] = fetcher.mock.calls[0]!;
    expect(String(address)).toBe('https://trawl.invalid/scrape');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({ url: azulCargoTrackingUrl(NUMBER), skipHttp: true, maxTier: 3 });
    expect(JSON.parse(String(init?.body)).maxTimeout).toBeLessThanOrEqual(10_000);
    await expect(new AzulCargoTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('preserves upstream refusals and rejects a redirect to another page', async () => {
    const response = (statusCode: number, url = azulCargoTrackingUrl(NUMBER)) => new Response(JSON.stringify({ url, html: page(card()), tier: 3, statusCode }));
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new AzulCargoTracker({ trawl: new TrawlClient('https://trawl.invalid', fetcher), now: () => NOW });
    fetcher.mockResolvedValueOnce(response(429));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    fetcher.mockResolvedValueOnce(response(200, 'https://www.azullogistica.com.br/'));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
