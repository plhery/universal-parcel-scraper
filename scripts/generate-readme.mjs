import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// GitHub's light and dark surfaces. The dark diagram is the light one with these colours swapped.
const themes = {
  light: { ink: '#1f2328', muted: '#59636e', line: '#d1d9e0', box: '#f6f8fa', accent: '#0b8068', tint: '#e6f4f0', other: '#9aa2ab' },
  dark: { ink: '#f0f6fc', muted: '#9198a1', line: '#3d444d', box: '#151b23', accent: '#2a9d85', tint: '#12302b', other: '#59626d' },
};
const rows = [
  { label: 'This project, all fallbacks enabled', count: union, own: true },
  { label: 'This project, dedicated adapters alone', count: summary.comparison.direct, own: true },
  ...sources.map(source => ({ label: source, count: counts[source], own: false })),
];
function chart(theme) {
  const left = 270, scale = 420, pitch = 34, top = 44, bottom = top + rows.length * pitch;
  const at = count => Math.round(left + count / coverage.length * scale);
  const bar = (row, index) => {
    const y = top + index * pitch + 8, width = Math.max(8, at(row.count) - left);
    return [
      `  <text x="0" y="${y + 13.5}" fill="${theme.ink}"${row.own ? ' font-weight="600"' : ''}>${row.label}</text>`,
      `  <path d="M${left} ${y}h${width - 4}a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-${width - 4}z" fill="${row.own ? theme.accent : theme.other}"/>`,
      `  <text x="${left + width + 8}" y="${y + 13.5}" fill="${theme.ink}"${row.own ? ' font-weight="600"' : ''}>${row.count}</text>`,
    ].join('\n');
  };
  const ticks = [0, coverage.length / 2, coverage.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 ${bottom + 30}" role="img" aria-label="Carriers with tracking history, by source">`,
    `  <style>text { font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; }</style>`,
    `  <text x="0" y="16" fill="${theme.muted}">Carriers with tracking history, out of ${coverage.length}</text>`,
    `  <rect x="${left + scale - 222}" y="6" width="10" height="10" rx="2" fill="${theme.accent}"/>`,
    `  <text x="${left + scale - 206}" y="16" fill="${theme.muted}">this project</text>`,
    `  <rect x="${left + scale - 118}" y="6" width="10" height="10" rx="2" fill="${theme.other}"/>`,
    `  <text x="${left + scale - 102}" y="16" fill="${theme.muted}">one source alone</text>`,
    ...ticks.map(tick => `  <path d="M${at(tick) + .5} ${top}V${bottom}" stroke="${theme.line}"/>`),
    ...rows.map(bar),
    ...ticks.map(tick => `  <text x="${at(tick)}" y="${bottom + 20}" fill="${theme.muted}" text-anchor="middle" style="font-size: 11.5px">${tick}</text>`),
    '</svg>', '',
  ].join('\n');
}
const picture = (name, alt) => [
  '<picture>',
  `  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/${name}-dark.svg">`,
  `  <img src="docs/assets/${name}-light.svg" alt="${alt}" width="760">`,
  '</picture>',
].join('\n');
const blocks = {
  summary: `**${documents.length} carriers · ${activeAdapters} active dedicated adapters · ${countries} countries represented**`,
  coverage: [
    picture('coverage', `Carriers with tracking history: ${rows.map(row => `${row.label} ${row.count}`).join(', ')}.`),
    '', '<details>', '<summary>The same numbers as a table</summary>', '',
    '| Source | Carriers with history |', '| --- | ---: |',
    `| **Universal Parcel Scraper, all fallbacks enabled** | **${union} / ${coverage.length}** |`,
    `| Dedicated adapters alone | ${summary.comparison.direct} / ${coverage.length} |`,
    ...sources.map(source => `| ${source} | ${counts[source]} / ${coverage.length} |`),
    '', '</details>',
  ].join('\n'),
};
const readme = path.join(root,'README.md');
let next = readFileSync(readme,'utf8');
for (const [name, content] of Object.entries(blocks)) {
  const start = `<!-- GENERATED:${name} -->`, end = `<!-- /GENERATED:${name} -->`;
  if (!next.includes(start) || !next.includes(end)) throw new Error(`Missing README ${name} markers`);
  next = next.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${content}\n${end}`);
}
const diagram = readFileSync(path.join(root,'docs/assets/how-it-works-light.svg'),'utf8');
const outputs = { 'README.md': next, 'data/coverage-summary.json': JSON.stringify(summary,null,2)+'\n',
  'docs/assets/coverage-light.svg': chart(themes.light), 'docs/assets/coverage-dark.svg': chart(themes.dark),
  'docs/assets/how-it-works-dark.svg': Object.keys(themes.light).reduce((svg, role) => svg.replaceAll(themes.light[role], themes.dark[role]), diagram) };
for (const [name, content] of Object.entries(outputs)) {
  const file = path.join(root,name);
  if (process.argv.includes('--check')) {
    if (!existsSync(file) || readFileSync(file,'utf8') !== content) throw new Error(`${name} is stale; run npm run generate`);
  } else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file,content); }
}
console.log('README coverage and its chart are generated from the catalog and comparison references.');
