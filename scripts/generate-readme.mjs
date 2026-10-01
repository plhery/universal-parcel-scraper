import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documents = readdirSync(path.join(root, 'carriers'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => JSON.parse(readFileSync(path.join(root, 'carriers', entry.name, 'carrier.json'), 'utf8')));
const coverage = JSON.parse(readFileSync(path.join(root, 'providers/coverage.json'), 'utf8')).carriers;
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
const blocks = {
  summary: `**${documents.length} carriers · ${activeAdapters} active dedicated adapters · ${countries} countries represented**`,
  coverage: [
    '| Source | Carriers with history |', '| --- | ---: |',
    `| **Universal Parcel Scraper, all fallbacks enabled** | **${union} / ${coverage.length}** |`,
    `| Dedicated adapters alone | ${summary.comparison.direct} / ${coverage.length} |`,
    ...sources.map(source => `| ${source} | ${counts[source]} / ${coverage.length} |`),
  ].join('\n'),
};
const readme = path.join(root,'README.md');
let next = readFileSync(readme,'utf8');
for (const [name, content] of Object.entries(blocks)) {
  const start = `<!-- GENERATED:${name} -->`, end = `<!-- /GENERATED:${name} -->`;
  if (!next.includes(start) || !next.includes(end)) throw new Error(`Missing README ${name} markers`);
  next = next.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${content}\n${end}`);
}
const outputs = { 'README.md': next, 'data/coverage-summary.json': JSON.stringify(summary,null,2)+'\n' };
for (const [name, content] of Object.entries(outputs)) {
  const file = path.join(root,name);
  if (process.argv.includes('--check')) {
    if (!existsSync(file) || readFileSync(file,'utf8') !== content) throw new Error(`${name} is stale; run npm run generate`);
  } else writeFileSync(file,content);
}
console.log('README coverage is generated from the catalog and comparison references.');
