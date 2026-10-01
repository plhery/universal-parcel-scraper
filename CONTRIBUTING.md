# Contributing

Use Node.js 24 or newer. Run `npm ci`, `npm run generate`, `npm run lint`,
`npm run typecheck`, `npm test`, `npm run test:scripts`, `npm run test:generated`,
`npm run build` and `npm run test:package`.

To add a carrier, run `npm run carrier:new -- --id example --name "Example" --canary-url https://example.com/`.
Fill its catalog document, add public or synthetic number examples, implement retrieval and a
pure parser, and add synthetic fixtures with offline tests. Declare recognition only when a
cheap anonymous HTTP lookup can positively distinguish a known parcel from an unknown one.
Regenerate the catalog and registry. The existing carrier folders show the adapter contract.

Keep recipient details, capability links, private tracking numbers and postcodes out of Git,
issues and logs. Live tests read private inputs from environment variables or ignored files.
Run `npm run test:carriers:live` only when you intend to contact upstream services. Do not
turn a blocked or inconclusive response into a successful test.

Keep carrier READMEs short: scope, retrieval, reasons for non-obvious choices, limits and how
to run the live test. Catalog facts belong in the JSON files. Provider results belong in
[providers/COVERAGE.md](providers/COVERAGE.md). `npm run generate` updates the README counts.

The public entry points, result shape, carrier ids, provider names and published data schemas
follow semver. Fixes are patches; additive carriers, fields and exports are minor releases;
removals, renames and stage-vocabulary changes are major releases. Version 0.x is the initial
API line. Consumers should pin exact versions.

The release workflow is dispatched with a version. It validates, builds package and container
artifacts, tags the commit and creates a GitHub release. npm publication is opt-in and requires
this repository to be configured as the package's npm trusted publisher. The first npm
publication may require the owner's npm account. TRAWL publication includes upstream and
patch source archives under its AGPL license.
