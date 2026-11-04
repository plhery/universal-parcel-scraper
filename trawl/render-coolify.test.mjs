import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync } from 'node:zlib';
import { alphabet, encodeSource, decodeSource } from './source-encoding.mjs';

test('Coolify installs every Dockerfile source with identical bytes and build steps', () => {
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  const rendered = execFileSync(process.execPath, [new URL('./render-coolify.mjs', import.meta.url).pathname], { encoding: 'utf8', cwd: '/tmp' });
  const match = /printf '%s' ([\s\S]+?) > \/tmp\/upc-trawl-sources.b91/.exec(rendered);
  assert.ok(match);
  const chunks = [...match[1].matchAll(/'([^']+)'/g)].map(row => row[1]);
  assert.ok(chunks.length > 1);
  const length = Number(/"utf8"\),(\d+),/.exec(rendered)?.[1]);
  const sources = JSON.parse(brotliDecompressSync(decodeSource(chunks.join(''), length, alphabet)).toString('utf8'));
  const copies = [...dockerfile.matchAll(/^COPY (\S+) (\S+)$/gm)];
  assert.equal(Object.keys(sources).length, copies.length);
  for (const [, file, target] of copies) assert.equal(sources[target], readFileSync(new URL(file, import.meta.url), 'utf8'), file);
  assert.ok(rendered.includes(dockerfile.slice(dockerfile.lastIndexOf('\nRUN ') + 5).trim()));
  assert.ok(rendered.includes(dockerfile.slice(0, copies[0].index).trimEnd()));
  assert.ok(rendered.includes('mkdirSync(dirname(path),{recursive:true})'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: new URL('.', import.meta.url) }).trim();
  assert.match(rendered, new RegExp(`^LABEL org\\.opencontainers\\.image\\.revision="${head}(-dirty)?"$`, 'm'));
  // Coolify embeds the Dockerfile in one base64 SSH argument. Leave room for
  // its wrapper, under 1 KiB, and at least 6 KiB for ARG lines beneath Linux's
  // 128 KiB per-argument limit.
  assert.ok(Buffer.byteLength(Buffer.from(rendered).toString('base64')) < 124_000);
  assert.ok(rendered.split('\n').every(line => Buffer.byteLength(line) < 65_535));
});

test('source encoding preserves all bytes, bit boundaries and bounded shell-safe output', () => {
  assert.equal(alphabet.length, 91);
  assert.equal(new Set(alphabet).size, 91);
  assert.doesNotMatch(alphabet, /['"\\\s]/);
  for (const size of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 256, 16384, 100001]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => index * 29 % 256));
    assert.deepEqual(decodeSource(encodeSource(bytes), bytes.length, alphabet), bytes);
  }
});

test('source decoding rejects malformed alphabets and length mismatches', () => {
  assert.throws(() => decodeSource('"', 1, alphabet));
  assert.throws(() => decodeSource('00', 0, alphabet));
  assert.throws(() => decodeSource('', 1, alphabet));
  assert.throws(() => decodeSource('00', -1, alphabet));
  for (const byte of [0, 255]) for (const size of [1, 2, 13, 14, 1000]) {
    const input = Buffer.alloc(size, byte);
    assert.deepEqual(decodeSource(encodeSource(input), size, alphabet), input);
  }
});
