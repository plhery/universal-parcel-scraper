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

npm has two channels, and `.github/workflows/release.yml` publishes both as the package's npm
trusted publisher. A push to `main` that changes the files a consumer installs is published as
`X.Y.Z-main.N` under the `next` tag, where `N` is the commit count. A push that only touches
Markdown, or leaves those files unchanged, publishes nothing. Dispatching the workflow with the
version in `package.json` validates, builds package and container artifacts, tags the commit
and creates a GitHub release; publishing that version to npm under `latest` is opt-in. TRAWL
publication includes upstream and patch source archives under its AGPL license.
