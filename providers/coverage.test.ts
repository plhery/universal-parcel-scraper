// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARRIER_CATALOG } from '../generated/catalog.js';
import { CARRIER_COVERAGE, COVERAGE_SOURCES, coverageProblems, coverageTiers, isHistory, type CoverageCell } from './coverage.js';
import { orderUniversalSources, universalPlan, UNIVERSAL_PROVIDERS } from './universal.js';
import type { UniversalSource } from './shared/result.js';

const providersDirectory = path.dirname(fileURLToPath(import.meta.url));
const COVERAGE_PATH = path.join(providersDirectory, 'COVERAGE.md');
const AGGREGATORS = COVERAGE_SOURCES.filter((source) => source !== 'UPU');
const catalog = CARRIER_CATALOG as Record<string, { displayName: string }>;

const WORDS: Record<string, string> = {
  no_history: 'No history', summary_only: 'Summary only', undated: 'Undated', sign_in: 'Sign-in', postcode_prompt: 'Postcode prompt',
  wrong_carrier: 'Wrong carrier', refused: 'Refused', subscriber_only: 'Subscribers only', error: 'Error', blocked: 'Blocked',
  unverified: 'Unverified', 'n/a': 'N/A',
};
function cellText(cell: CoverageCell | undefined): string {
  if (typeof cell === 'number') return `✓ ${cell}`;
  if (typeof cell === 'object') return `✓ ${cell.rows}, partial`;
  if (cell === 'history') return '✓';
  return WORDS[cell!]!;
}

function coverageTable(): string {
  const rows = CARRIER_COVERAGE.map((entry) => {
    const folder = path.join(providersDirectory, '..', 'carriers', entry.carrier);
    const link = existsSync(path.join(folder, 'README.md')) ? 'README.md' : 'carrier.json';
    const name = entry.name ?? catalog[entry.carrier]!.displayName;
    // A courier kept for subscribers outranks what the comparison reference once returned.
    const results = COVERAGE_SOURCES.map((source) => cellText(entry.references
      .some((reference) => reference.results[source] === 'subscriber_only') ? 'subscriber_only' : entry.references[0]!.results[source]));
    return `| [${name}](../carriers/${entry.carrier}/${link}) | ${entry.direct} | ${entry.sample} | ${results.join(' | ')} |`;
  });
  return [`| Carrier | Direct support | Direct sample | ${COVERAGE_SOURCES.join(' | ')} |`,
    `| --- | --- | --- | ${COVERAGE_SOURCES.map(() => '---').join(' | ')} |`, ...rows].join('\n');
}

function lookupOrder(): string {
  const tiers = CARRIER_COVERAGE.map((entry) => coverageTiers(entry.carrier)!);
  const totals = AGGREGATORS.map((source) => {
    const known = tiers.filter((tier) => ['full', 'partial'].includes(tier[source])).length;
    const full = tiers.filter((tier) => tier[source] === 'full').length;
    const only = tiers.filter((tier) => AGGREGATORS.every((other) => other === source
      ? ['full', 'partial'].includes(tier[other]) : !['full', 'partial'].includes(tier[other]))).length;
    return `| ${source} | ${known} | ${full} | ${known - full} | ${only} |`;
  });
  // Providers of one tier share a carrier's numbers; the tiers are asked in turn.
  const chain = (carrier?: string) => {
    const plan = universalPlan({ carriers: [carrier], enablePostalNinja: true, enableTrack123: true, background: true });
    const tiers = new Map<string, UniversalSource[]>();
    for (const source of plan.sources.filter((source) => source !== 'UPU')) {
      const tier = `${UNIVERSAL_PROVIDERS[source].after ?? 0}:${plan.rank(source)}`;
      tiers.set(tier, [...(tiers.get(tier) ?? []), source]);
    }
    return [...tiers.values()].map((sources) => sources.join(' · ')).join(' → ');
  };
  const unnamed = chain();
  const standard = chain(Object.keys(catalog).find((carrier) => carrier !== 'unknown' && !coverageTiers(carrier)));
  const orders = CARRIER_COVERAGE.filter((entry) => chain(entry.carrier) !== standard)
    .map((entry) => `| ${entry.name ?? catalog[entry.carrier]!.displayName} | ${chain(entry.carrier)} |`);
  return [
    '| Source | Carriers with history | Full | Partial | Only source |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...totals,
    '',
    `Providers joined by a dot have equally full history for the carrier and share its numbers; an arrow leads to those asked when they have none. With Postal Ninja enabled, a number no carrier is named for uses ${unnamed}. A carrier without its own order uses ${standard}. These carriers have their own:`,
    '',
    '| Carrier | Order |',
    '| --- | --- |',
    ...orders,
  ].join('\n');
}

function replaceBlock(text: string, name: string, content: string): string {
  const start = `<!-- GENERATED:${name} -->`;
  const end = `<!-- /GENERATED:${name} -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`COVERAGE.md has no ${name} block`);
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
}

describe('coverage evidence', () => {
  it('holds valid results for catalog carriers, each once, with a complete comparison reference', () => {
    const ids = CARRIER_COVERAGE.map((entry) => entry.carrier);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CARRIER_COVERAGE) {
      expect(catalog[entry.carrier], entry.carrier).toBeDefined();
      expect(coverageProblems(entry), entry.carrier).toEqual([]);
      expect(COVERAGE_SOURCES.filter((source) => !(source in entry.references[0]!.results)), entry.carrier).toEqual([]);
      if (entry.name) expect(entry.name).not.toBe(catalog[entry.carrier]!.displayName);
    }
  });

  it('reports invalid results', () => {
    expect(coverageProblems({ carrier: 'x', direct: '', sample: '', references: [] })).toEqual(['no reference']);
    expect(coverageProblems({ carrier: 'x', direct: '', sample: '', references: [{ results: {
      Ship24: 0, ParcelsApp: 'maybe' as never, UPU: { rows: 2, partial: '' }, Other: 1,
    } as never }] })).toEqual([
      'reference 1: invalid Ship24 result 0',
      'reference 1: invalid ParcelsApp result "maybe"',
      'reference 1: invalid UPU result {"rows":2,"partial":""}',
      'reference 1: unknown source Other',
    ]);
    expect(isHistory('no_history')).toBe(false);
    expect(isHistory({ rows: 1, partial: 'one row' })).toBe(true);
  });

  it('grades each provider from all of a carrier\'s references', () => {
    // 17TRACK had every USPS history; ParcelsApp missed one it had.
    expect(coverageTiers('usps')).toMatchObject({ '17TRACK': 'full', ParcelsApp: 'partial', Ship24: 'empty', 'Postal Ninja': 'empty' });
    // Marked partial for one reference.
    expect(coverageTiers('la-poste')).toMatchObject({ Ship24: 'partial' });
    // A courier kept for subscribers excludes the provider, whatever history it once returned.
    expect(coverageTiers('ups')).toMatchObject({ Ship24: 'excluded', ParcelsApp: 'full' });
    expect(coverageTiers('royal-mail')).toMatchObject({ Ship24: 'excluded' });
    expect(coverageTiers('sf-express')).toMatchObject({ Ship24: 'excluded' });
    // ParcelsApp missed an Express waybill Ship24 knew.
    expect(coverageTiers('dhl-express')).toMatchObject({ Ship24: 'full', ParcelsApp: 'partial' });
    // A stranger's parcel or a refused format excludes a provider without history.
    expect(coverageTiers('yamato')).toMatchObject({ ParcelsApp: 'excluded', '17TRACK': 'full' });
    expect(coverageTiers('purolator')).toMatchObject({ 'Postal Ninja': 'excluded', '17TRACK': 'full' });
    // Negatives on references too old to say anything.
    expect(coverageTiers('posti')).toMatchObject({ Ship24: 'unknown', ParcelsApp: 'unknown' });
    expect(coverageTiers('unknown')).toBeNull();
    expect(coverageTiers(null)).toBeNull();
  });

  it('never leaves a carrier without an aggregator to ask', () => {
    for (const entry of CARRIER_COVERAGE) {
      expect(universalPlan({ carriers: [entry.carrier] }).sources.filter((source) => source !== 'UPU').length, entry.carrier).toBeGreaterThan(0);
    }
  });

  it('keeps the generated tables of COVERAGE.md current', () => {
    const current = readFileSync(COVERAGE_PATH, 'utf8');
    const next = replaceBlock(replaceBlock(current, 'coverage', coverageTable()), 'lookup-order', lookupOrder());
    if (process.env.UPDATE_COVERAGE_TABLES) writeFileSync(COVERAGE_PATH, next);
    else expect(current, 'Run node scripts/coverage-tables.mjs').toBe(next);
  });
});

describe('coverage-based lookup order', () => {
  it('prioritizes the provider with complete Express history for ambiguous ten-digit numbers', () => {
    expect(universalPlan({ trackingNumber: '1234567891' }).sources[0]).toBe('Ship24');
    expect(universalPlan({ carriers: ['dhl-express'], trackingNumber: '1234567891' }).sources[0]).toBe('Ship24');
  });
  const plan = (carrier: string, options: { trackingNumber?: string; enablePostalNinja?: boolean } = {}) =>
    universalPlan({ carriers: [carrier], enablePostalNinja: true, ...options });

  it('asks fuller history first, and the fast HTTP providers first within a tier unless the lookup runs in the background', () => {
    expect(plan('usps').sources).toEqual(['17TRACK', 'ParcelsApp', 'Ordertracker', 'Ship24', 'UPU']);
    // Ordertracker answers seconds later, as the browser service does.
    expect(plan('la-poste').sources).toEqual(['ParcelsApp', 'Ordertracker', '17TRACK', 'Ship24', 'Postal Ninja', 'UPU']);
    expect(plan('spring-gds').sources).toEqual(['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU']);
    expect(plan('la-poste').rank('ParcelsApp')).toBeLessThan(plan('la-poste').rank('Ship24'));
    // ParcelsApp, Ordertracker and 17TRACK have La Poste's history equally: in the background each leads
    // some numbers, Ordertracker more than ParcelsApp, and Ship24's partial history stays behind them.
    const leaders = new Map<UniversalSource, number>();
    for (let index = 0; index < 600; index++) {
      const { sources } = universalPlan({ carriers: ['la-poste'], trackingNumber: `6A${10_000_000_000 + index * 7919}`, background: true });
      expect(sources.indexOf('Ship24')).toBe(3);
      leaders.set(sources[0]!, (leaders.get(sources[0]!) ?? 0) + 1);
    }
    expect([...leaders.keys()].sort()).toEqual(['17TRACK', 'Ordertracker', 'ParcelsApp']);
    expect(leaders.get('Ordertracker')).toBeGreaterThan(leaders.get('ParcelsApp')!);
    expect(leaders.get('ParcelsApp')).toBeGreaterThan(leaders.get('17TRACK')!);
  });

  it('asks Postal Ninja after the other aggregators and never ranks it fuller than them', () => {
    // Its rows rarely carry a clock a consumer can place, whatever their count.
    for (const carrier of ['ups', 'australia-post', 'china-post', 'geodis']) {
      const { sources, tier, rank } = plan(carrier);
      expect(sources.slice(-2), carrier).toEqual(['Postal Ninja', 'UPU']);
      expect(['full', 'partial'], carrier).toContain(tier('Postal Ninja'));
      for (const other of sources.filter((source) => source !== 'UPU')) expect(rank('Postal Ninja'), carrier).toBeGreaterThanOrEqual(rank(other));
    }
  });

  it('asks Postal Ninja about a carrier only when its evidence shows Postal Ninja history', () => {
    // No history, nothing conclusive, a refused format, no evidence at all.
    for (const carrier of ['usps', 'quickpac', 'purolator', 'imile']) expect(plan(carrier).sources, carrier).not.toContain('Postal Ninja');
    expect(universalPlan({ carriers: ['unknown', null, 'royal-mail'], enablePostalNinja: true }).sources).toContain('Postal Ninja');
    // A number no carrier is named for.
    expect(universalPlan({ carriers: ['unknown'], enablePostalNinja: true }).sources).toEqual(['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU']);
    expect(universalPlan({ enablePostalNinja: true }).sources).toContain('Postal Ninja');
  });

  it('leaves out excluded providers and Postal Ninja when it is disabled', () => {
    expect(plan('yamato').sources).not.toContain('ParcelsApp');
    expect(plan('ups').sources).toEqual(['ParcelsApp', 'Ordertracker', '17TRACK', 'Postal Ninja', 'UPU']);
    // Not even as the provider a ten-digit number puts first.
    expect(plan('sf-express', { trackingNumber: '1234567891' }).sources).not.toContain('Ship24');
    expect(plan('australia-post', { enablePostalNinja: false }).sources).toEqual(['Ship24', 'ParcelsApp', '17TRACK', 'UPU']);
  });

  it('asks Ordertracker only about the carrier the lookup is for, when its feeds were checked', () => {
    for (const carrier of ['ups', 'fedex', 'usps', 'canada-post', 'la-poste', 'chronopost']) expect(plan(carrier).sources, carrier).toContain('Ordertracker');
    for (const carrier of ['dhl', 'royal-mail', 'unknown']) expect(plan(carrier).sources, carrier).not.toContain('Ordertracker');
    expect(universalPlan({ carriers: [null, 'ups'] }).sources).not.toContain('Ordertracker');
    expect(universalPlan({}).sources).not.toContain('Ordertracker');
  });

  it('keeps UPU last and postal-only, and China Post C/L numbers on 17TRACK first', () => {
    expect(plan('usps', { trackingNumber: '9400100000000000000000' }).sources).not.toContain('UPU');
    expect(plan('china-post', { trackingNumber: 'LZ000000005CN' }).sources[0]).toBe('17TRACK');
    expect(plan('china-post', { trackingNumber: 'LZ000000005CN' }).sources.at(-1)).toBe('UPU');
  });

  it('uses the first carrier with evidence, else the default order', () => {
    expect(universalPlan({ carriers: ['unknown', null, 'usps'] })).toMatchObject({ carrier: 'usps', sources: ['17TRACK', 'ParcelsApp', 'Ship24', 'UPU'] });
    const standard = universalPlan({ carriers: ['unknown'] });
    expect(standard).toMatchObject({ carrier: null, sources: ['Ship24', 'ParcelsApp', '17TRACK', 'UPU'] });
    expect(standard.tier('Ship24')).toBe('unknown');
    expect(standard.rank('Ship24')).toBe(standard.rank('17TRACK'));
  });

  it('keeps every provider when evidence would exclude them all', () => {
    const excluded: Partial<Record<UniversalSource, 'excluded'>> = { Ship24: 'excluded', ParcelsApp: 'excluded', '17TRACK': 'excluded' };
    expect(orderUniversalSources(['ParcelsApp', 'Ship24', '17TRACK', 'UPU'], excluded)).toEqual(['Ship24', 'ParcelsApp', '17TRACK', 'UPU']);
    expect(orderUniversalSources(['ParcelsApp', 'Ship24', '17TRACK', 'UPU'], { Ship24: 'excluded', UPU: 'full' }))
      .toEqual(['ParcelsApp', '17TRACK', 'UPU']);
  });
});

describe("a consumer's own counts", () => {
  it('replace the tier the references give once they cover ten parcels', () => {
    expect(coverageTiers('usps', { ParcelsApp: { history: 9, missed: 0 } })).toMatchObject({ ParcelsApp: 'partial' });
    expect(coverageTiers('usps', { ParcelsApp: { history: 45, missed: 5 }, '17TRACK': { history: 6, missed: 6 }, Ship24: { history: 1, missed: 60 } }))
      .toMatchObject({ ParcelsApp: 'full', '17TRACK': 'partial', Ship24: 'empty' });
    expect(coverageTiers('usps', { Ship24: { history: 0, missed: 10 } })).toMatchObject({ Ship24: 'excluded', '17TRACK': 'full' });
    // Counts that are no counts say nothing.
    expect(coverageTiers('usps', { ParcelsApp: { history: Number.NaN, missed: -40 } })).toEqual(coverageTiers('usps'));
  });

  it('keep what a count cannot see: a provider the references exclude, and history they mark partial', () => {
    expect(coverageTiers('ups', { Ship24: { history: 50, missed: 0 } })).toMatchObject({ Ship24: 'excluded' });
    expect(coverageTiers('la-poste', { Ship24: { history: 50, missed: 0 } })).toMatchObject({ Ship24: 'partial' });
    expect(coverageTiers('la-poste', { Ship24: { history: 0, missed: 50 } })).toMatchObject({ Ship24: 'excluded' });
  });

  it('grade a carrier that has no reference', () => {
    expect(coverageTiers('azul-cargo')).toBeNull();
    expect(coverageTiers('azul-cargo', { Ship24: { history: 3, missed: 1 } })).toBeNull();
    expect(coverageTiers('azul-cargo', { Ship24: { history: 12, missed: 1 }, Track123: { history: 0, missed: 14 } }))
      .toMatchObject({ Ship24: 'full', ParcelsApp: 'unknown', Track123: 'excluded' });
  });

  it('order the plan of the carrier the lookup is for', () => {
    const number = '9400100000000000000000';
    // The references alone put 17TRACK before ParcelsApp for USPS.
    expect(universalPlan({ carriers: ['usps'], trackingNumber: number }).sources).toEqual(['17TRACK', 'ParcelsApp', 'Ordertracker', 'Ship24']);
    const observed = { ParcelsApp: { history: 45, missed: 5 }, Ship24: { history: 0, missed: 30 } };
    // Counted as full, ParcelsApp answers first for someone waiting, and Ship24 is no longer asked.
    const plan = universalPlan({ carriers: ['usps'], trackingNumber: number, observed });
    expect(plan.sources).toEqual(['ParcelsApp', '17TRACK', 'Ordertracker']);
    expect(plan.tier('ParcelsApp')).toBe('full');
    expect(plan.rank('ParcelsApp')).toBe(plan.rank('17TRACK'));
    // In the background the two share USPS's numbers.
    const leaders = new Set<UniversalSource>();
    for (let index = 0; index < 200; index++) {
      leaders.add(universalPlan({ carriers: ['usps'], trackingNumber: String(9_400_100_000_000_000_000_000n + BigInt(index * 7919)), observed, background: true }).sources[0]!);
    }
    expect([...leaders].sort()).toEqual(['17TRACK', 'ParcelsApp']);
    // A carrier without references is ordered by the counts alone.
    const counted = { '17TRACK': { history: 12, missed: 1 }, Ship24: { history: 0, missed: 12 } };
    expect(universalPlan({ carriers: ['azul-cargo'], trackingNumber: number, observed: counted }))
      .toMatchObject({ carrier: 'azul-cargo', sources: ['17TRACK', 'ParcelsApp'] });
    // The counts are that carrier's: they say nothing of a carrier confirmed or discovered for the number.
    expect(universalPlan({ carriers: ['azul-cargo', 'usps'], trackingNumber: number, observed: { Ship24: { history: 1, missed: 2 } } }))
      .toMatchObject({ carrier: 'usps', sources: ['17TRACK', 'ParcelsApp', 'Ship24'] });
    expect(universalPlan({ carriers: [undefined, 'usps'], trackingNumber: number, observed: counted }).sources).toEqual(['17TRACK', 'ParcelsApp', 'Ship24']);
  });
});
