// Produce a self-contained Dockerfile for Coolify's Dockerfile application type.
// Source remains reviewable here; Coolify stores the generated build definition.
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(name, import.meta.url));
const base = read('Dockerfile').toString().split('\n')[0];
const license = read('LICENSE').toString('base64');
const capture = read('tracking-capture.mjs').toString('base64');
const fedex = read('fedex-session.mjs').toString('base64');
const australia = read('australia-post-browser.mjs').toString('base64');
const sfExpress = read('sf-express-session.mjs').toString('base64');
const sfGap = read('sf-express-gap.mjs').toString('base64');
const install = read('install.mjs').toString('base64');
console.log(`${base}
LABEL org.opencontainers.image.source="https://github.com/plhery/universal-parcel-scraper" org.opencontainers.image.licenses="AGPL-3.0-only"
RUN mkdir -p /usr/share/licenses/trawl && printf '%s' '${license}' | base64 -d > /usr/share/licenses/trawl/LICENSE
RUN printf '%s' '${capture}' | base64 -d > /app/packages/tiers/src/utils/tracking-capture.mjs \\
 && printf '%s' '${fedex}' | base64 -d > /app/packages/tiers/src/utils/fedex-session.mjs \\
 && printf '%s' '${australia}' | base64 -d > /app/packages/tiers/src/utils/australia-post-browser.mjs \\
 && printf '%s' '${sfExpress}' | base64 -d > /app/packages/tiers/src/utils/sf-express-session.mjs \\
 && printf '%s' '${sfGap}' | base64 -d > /app/packages/tiers/src/utils/sf-express-gap.mjs \\
 && printf '%s' '${install}' | base64 -d > /tmp/install-tracking-capture.mjs \\
 && bun /tmp/install-tracking-capture.mjs && rm /tmp/install-tracking-capture.mjs`);
