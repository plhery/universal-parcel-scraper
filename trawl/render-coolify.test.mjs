import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync } from 'node:zlib';

test('Coolify installs every Dockerfile source with identical bytes and build steps', () => {
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  const rendered = execFileSync(process.execPath, [new URL('./render-coolify.mjs', import.meta.url).pathname], { encoding: 'utf8', cwd: '/tmp' });
  const match = /printf '%s' ([\s\S]+?) \| base64 -d > \/tmp\/upc-trawl-sources.br/.exec(rendered);
  assert.ok(match);
  const chunks = [...match[1].matchAll(/'([A-Za-z0-9+/=]+)'/g)].map(row => row[1]);
  assert.ok(chunks.length > 1);
  const sources = JSON.parse(brotliDecompressSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8'));
  const copies = [...dockerfile.matchAll(/^COPY (\S+) (\S+)$/gm)];
  assert.equal(Object.keys(sources).length, copies.length);
  for (const [, file, target] of copies) assert.equal(sources[target], readFileSync(new URL(file, import.meta.url), 'utf8'), file);
  assert.ok(rendered.includes(dockerfile.slice(dockerfile.lastIndexOf('\nRUN ') + 5).trim()));
  assert.ok(rendered.includes(dockerfile.slice(0, copies[0].index).trimEnd()));
  assert.ok(rendered.includes('mkdirSync(dirname(path),{recursive:true})'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: new URL('.', import.meta.url) }).trim();
  assert.match(rendered, new RegExp(`^LABEL org\\.opencontainers\\.image\\.revision="${head}(-dirty)?"$`, 'm'));
  // Coolify embeds the Dockerfile in one base64 SSH argument. Leave room for
  // its wrapper, under 1 KiB, and the ARG lines it adds beneath Linux's
  // 128 KiB per-argument limit.
  assert.ok(Buffer.byteLength(Buffer.from(rendered).toString('base64')) < 120_000);
  assert.ok(rendered.split('\n').every(line => Buffer.byteLength(line) < 65_535));
});
