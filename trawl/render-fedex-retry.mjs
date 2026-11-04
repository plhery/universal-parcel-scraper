import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--', '.')) throw new Error('Retry worker sources must be committed');
const revision = git('rev-parse', 'HEAD');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const image = read('Dockerfile').match(/^FROM (ghcr.io\/germondai\/trawl:[^\s]+)$/m)?.[1];
if (!image?.includes('@sha256:')) throw new Error('Missing pinned browser image');
const files = ['fedex-session.mjs', 'fedex-residential-proxy.mjs', 'fedex-retry-server.mjs'];
const payload = gzipSync(JSON.stringify(Object.fromEntries(files.map(name => [name, read(name)])))).toString('base64');
console.log(`FROM ${image}
LABEL org.opencontainers.image.revision="${revision}" org.opencontainers.image.source="https://github.com/plhery/universal-parcel-scraper" org.opencontainers.image.licenses="AGPL-3.0-only"
ENV HOST=0.0.0.0 PORT=8192 LOG_LEVEL=warn
RUN bun -e 'import{writeFileSync}from"node:fs";import{gunzipSync}from"node:zlib";for(const[name,source]of Object.entries(JSON.parse(gunzipSync(Buffer.from("${payload}","base64")).toString())))writeFileSync("/app/packages/tiers/src/utils/"+name,source)'
WORKDIR /app
EXPOSE 8192
CMD ["bun", "/app/packages/tiers/src/utils/fedex-retry-server.mjs"]`);
