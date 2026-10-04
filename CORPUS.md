# Corpus

Two kinds of evidence sit in every carrier folder: the numbers detection is tested on and the
statuses the stage mapping is built from. Both are data, checked in next to the code that
reads them.

## Tracking numbers

`numbers.json` records sample numbers, where each one comes from and what detection should
answer for it. A sample is either public, with its source, or synthetic, with how it was
derived. [numbers.schema.json](core/testing/numbers.schema.json) defines the record.

A numeric shape that several carriers share only suggests a carrier. A distinctive family or
a verified checksum can select one. The corpus tests reject collisions nobody declared and
make sure every detection rule has an example.

```sh
npm test -- core/testing/detectionSweep
```

That run checks the corpus against its golden replay. After a deliberate change,
`node scripts/detection-golden.mjs` rewrites [detection-golden.json](data/detection-golden.json).

## Statuses

`statuses.json` records the status codes and wordings seen from a carrier. Each entry names
the stage it means and says how that was confirmed, by a live reply or the carrier's own
documentation for instance. A note explains the entries that are not obvious.

Some adapter tests replay these entries against the carrier's status map. Wording no carrier
map covers falls to the shared classifier in [core/status](core/status/wording.ts), which
has its own tests against audited histories.

## What never goes in

Private live-test numbers do not belong in the corpus. Provider and parser fixtures bind to
synthetic identities, and leave out recipient details and access credentials.
