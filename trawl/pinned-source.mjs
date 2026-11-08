// Self-contained so the renderer can put this installer in a Docker RUN.
export async function installPinnedSources(config, { fetcher = fetch, extract } = {}) {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  if (!/^[a-f0-9]{40}$/.test(config.revision) || !Array.isArray(config.files) || !config.files.length
    || config.files.some(f => !/^[a-z0-9][a-z0-9.-]*$/.test(f.name) || !/^[a-f0-9]{64}$/.test(f.sha256)
      || !f.target.startsWith('/'))) throw Error('Invalid pinned source manifest');
  const root = await fs.mkdtemp(join(tmpdir(), 'trawl-source-'));
  try {
    const response = await fetcher(`https://codeload.github.com/plhery/universal-parcel-scraper/tar.gz/${config.revision}`,
      { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw Error('Pinned source download failed');
    if (Number(response.headers.get('content-length')) > 50000000) throw Error('Pinned source archive too large');
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > 50000000) throw Error('Pinned source archive too large');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const archive = join(root, 'source.tgz'); await fs.writeFile(archive, Buffer.concat(chunks));
    if (extract) await extract(root, config);
    else execFileSync('tar', ['-xzf', archive, '-C', root, '--strip-components=2', ...config.files.map(f =>
      `universal-parcel-scraper-${config.revision}/trawl/${f.name}`)], { timeout: 30000, stdio: 'pipe' });
    const verified = [];
    for (const file of config.files) {
      const path = join(root, file.name);
      if (!(await fs.lstat(path)).isFile()) throw Error('Pinned source is not a regular file');
      const bytes = await fs.readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Pinned source hash mismatch');
      verified.push([file.target, bytes]);
    }
    for (const [target, bytes] of verified) { await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
