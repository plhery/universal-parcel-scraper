import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageChart, stagesFigure, terminal } from './readme-graphics.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const documents = readdirSync(path.join(root, 'carriers'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => read(`carriers/${entry.name}/carrier.json`));
const coverage = read('providers/coverage.json').carriers;
if (coverage.length !== 100) throw new Error('Update the reference-set label when the comparison cohort changes');
const sources = ['ParcelsApp','Postal Ninja','17TRACK','Ship24','UPU'];
const history = cell => typeof cell === 'number' && cell > 0 || cell === 'history'
  || cell && typeof cell === 'object' && cell.rows > 0;
// A leading check mark belongs to the comparison reference; later ones are alternates.
const direct = entry => /^✓\s*\d+/.test(entry.sample);
const counts = Object.fromEntries(sources.map(source => [source, coverage.filter(entry => history(entry.references[0].results[source])).length]));
const union = coverage.filter(entry => direct(entry) || sources.some(source => history(entry.references[0].results[source]))).length;
const activeAdapters = documents.filter(document => document.tracking.mode === 'automatic' && document.tracking.adapter === document.id
  && existsSync(path.join(root,'carriers',document.id,'adapter.ts'))).length;
const countries = new Set(documents.flatMap(document => document.region.countries)).size;
const summary = { catalog: documents.length, activeAdapters, countries, referenceCarriers: coverage.length,
  comparison: { combined: union, direct: coverage.filter(direct).length, providers: counts } };
const count = value => value.toLocaleString('en-US');
// The fallbacks reach what the largest aggregator says it follows.
const reach = Math.max(...Object.values(read('docs/reach.json')).map(provider => provider.carriers));
const rows = [
  { label: 'This project, all fallbacks enabled', count: union, own: true },
  { label: 'This project, dedicated adapters alone', count: summary.comparison.direct, own: true },
  ...sources.map(source => ({ label: source, count: counts[source], own: false })),
];
// Every status a carrier folder records, and one delivery round as six of them report it.
const statuses = documents.flatMap(document => existsSync(path.join(root,'carriers',document.id,'statuses.json'))
  ? read(`carriers/${document.id}/statuses.json`).entries.map(entry => ({ ...entry, carrier: document })) : []);
const stage = 'out_for_delivery';
const samples = [['dhl','Die Sendung wurde in das Zustellfahrzeug geladen.'], ['mondial-relay','En cours de livraison'],
  ['correios-br','Objeto saiu para entrega ao destinatário'], ['correos-express','EN REPARTO'], ['yamato','配達中'], ['la-poste','DISTOU']]
  .map(([carrier, label]) => {
    const entry = statuses.find(status => status.carrier.id === carrier && (status.wording ?? status.code) === label && status.stage === stage);
    if (!entry) throw new Error(`${carrier} no longer records "${label}" as ${stage}; pick another sample for the README`);
    return { carrier: entry.carrier.displayName, label, code: !entry.wording };
  });
// The terminal prints what detection answers for a number the corpus holds.
const sample = read('data/detection-golden.json').find(record => record.input === '1Z999AA10123456784');
if (sample?.confidence !== 'high') throw new Error('The README terminal needs a corpus number that detection names with high confidence');
const detected = JSON.stringify({ trackingNumber: sample.input, source: 'number', carrier: sample.carrier,
  confidence: sample.confidence, candidates: sample.candidates, preferred: [] }, null, 2).split('\n');
const picture = (name, alt) => `<img src="docs/assets/${name}.svg" alt="${alt}" width="760">`;
const best = Math.max(...Object.values(counts));
const blocks = {
  summary: [
    `**${count(reach)}+ carriers** through **${activeAdapters} dedicated adapters** and **${sources.length} universal fallbacks**`,
    '', `<sub>${documents.length} carriers in the catalog · ${countries} countries represented</sub>`,
  ].join('\n'),
  stages: [
    picture('stages', `${samples.map(entry => `${entry.carrier}: ${entry.label}`).join('; ')}. All are filed under ${stage}.`),
    '', `The carrier folders record ${count(statuses.length)} such statuses, each filed under one stage.`,
  ].join('\n'),
  coverage: [
    `Benchmarked against ${coverage.length} popular carriers, it returns tracking history for **${union}**. The best single aggregator returns ${best}.`,
    '', picture('coverage', `Carriers with tracking history: ${rows.map(row => `${row.label} ${row.count}`).join(', ')}.`),
  ].join('\n'),
};
const readme = path.join(root,'README.md');
let next = readFileSync(readme,'utf8');
for (const [name, content] of Object.entries(blocks)) {
  const start = `<!-- GENERATED:${name} -->`, end = `<!-- /GENERATED:${name} -->`;
  if (!next.includes(start) || !next.includes(end)) throw new Error(`Missing README ${name} markers`);
  next = next.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${content}\n${end}`);
}
const outputs = { 'README.md': next, 'data/coverage-summary.json': JSON.stringify(summary,null,2)+'\n',
  'docs/assets/terminal.svg': terminal(`npx universal-parcel-scraper detect ${sample.input}`, detected),
  'docs/assets/coverage.svg': coverageChart(rows, coverage.length),
  'docs/assets/stages.svg': stagesFigure(samples, stage, read('data/stages.json')) };
for (const [name, content] of Object.entries(outputs)) {
  const file = path.join(root,name);
  if (process.argv.includes('--check')) {
    if (!existsSync(file) || readFileSync(file,'utf8') !== content) throw new Error(`${name} is stale; run npm run generate`);
  } else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file,content); }
}
console.log('The README counts and pictures are generated from the catalog, the status records and the comparison references.');
