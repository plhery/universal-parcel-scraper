# Tracking-number corpus

Each carrier's `numbers.json` records synthetic or public examples, their sources and the
expected detection result. Shared numeric shapes are suggestions; distinctive families and
verified checksums can select a carrier. Corpus tests reject undeclared collisions and ensure
that every detection rule has an example.

`npm test -- core/testing/detectionSweep` checks the corpus and its golden replay.
`node scripts/detection-golden.mjs` updates [data/detection-golden.json](data/detection-golden.json).
Private live-test numbers never belong in the corpus. Provider and parser fixtures must bind
to synthetic identities and omit recipient details and access credentials.
