# Project instructions

- This is open source. Keep secrets, private tracking numbers, postcodes, capability URLs and internal testing details out of repository files, comments, commit messages and issues. Use synthetic fixtures and private live-test inputs outside Git.
- After a requested change, validate, stage the relevant files, commit and push directly to `main`. Do not create a branch or pull request unless explicitly requested.
- Before pushing, confirm no secrets or unrelated generated artifacts are included.
- Never import from an app or framework. Browser exports must remain free of Node runtime imports. Resolve assets against their module, not the consumer's working directory.
- Public exports, result fields, error kinds, carrier ids, provider names and data schemas follow semver. Fixes are patches; additive changes are minor; removals, renames and new stages are major. Until 1.0.0 a major change raises the minor version. Do not rename ids or stages in place. The `/app` entry point is exempt: it follows the parcel app.
- Commercial universal providers are opt-in. Consumers own polling and persistence.

## Documentation

Keep docs short, plain and current. No dates, verification logs, changelogs, one-off timings or hedging. Do not copy catalog, sample-number or status facts out of their machine-readable source. No status or field tables in READMEs.

Carrier and provider READMEs cover scope, retrieval, non-obvious choices with their reasons, limitations and the live-test command. Follow `npm run carrier:new`. Provider evidence belongs in `providers/COVERAGE.md`; adapter and facade policy in `ARCHITECTURE.md`. Generate README counts with `npm run generate` and update docs in the same commit as behavior.
