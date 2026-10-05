FROM ghcr.io/germondai/trawl:1.5.0@sha256:9cf6668dc5e7160d739991ca1edfe308c48638696571d9413a18399696586698
LABEL org.opencontainers.image.source="https://github.com/plhery/universal-parcel-scraper" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY LICENSE /usr/share/licenses/trawl/LICENSE
COPY tracking-capture.mjs /app/packages/tiers/src/utils/tracking-capture.mjs
COPY royal-mail-history.mjs /app/packages/tiers/src/utils/royal-mail-history.mjs
COPY fedex-session.mjs /app/packages/tiers/src/utils/fedex-session.mjs
COPY australia-post-browser.mjs /app/packages/tiers/src/utils/australia-post-browser.mjs
COPY dhl-express-browser.mjs /app/packages/tiers/src/utils/dhl-express-browser.mjs
COPY sf-express-session.mjs /app/packages/tiers/src/utils/sf-express-session.mjs
COPY sf-express-gap.mjs /app/packages/tiers/src/utils/sf-express-gap.mjs
COPY install.mjs /tmp/install-tracking-capture.mjs
RUN bun /tmp/install-tracking-capture.mjs && rm /tmp/install-tracking-capture.mjs
