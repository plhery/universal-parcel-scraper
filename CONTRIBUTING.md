# Contributing

Carriers change their sites, so most contributions are small: an adapter that stopped
working, a status nobody had seen, a number format detection missed. All of them are welcome,
and so are new carriers.

## Setup

Use Node.js 24 or newer.

```sh
npm ci
npm test
```

Before pushing, run what CI runs:

```sh
npm run generate         # catalog, registry, coverage tables, README counts and pictures
npm run lint
npm run typecheck
npm test
npm run test:scripts
npm run test:generated   # fails when a generated file is stale
npm run build
npm run test:package     # packs the tarball, installs it and imports every entry point
```

## Fix a carrier

Start with the carrier's README in `carriers/<id>/`. It says how the site is read and which
choices were deliberate. Then reproduce the problem offline: add or adjust a synthetic fixture,
make the parser test fail, and fix it.

Live tests contact the carrier, so run them only when you mean to:

```sh
npm run test:carriers:live -- carriers/<id>
```

They read private inputs from environment variables or ignored files. Do not turn a blocked
or inconclusive response into a passing test.

A scheduled canary run looks up wrong numbers through every public adapter and provider, and
keeps one issue open for as long as something fails. That issue is a good place to find work.

## Add a carrier

```sh
npm run carrier:new -- --id example --name "Example" --canary-url https://example.com/
```

The script writes the folder. From there:

1. Fill `carrier.json`: the portal facts, the tracking links and the detection rules.
2. Add public or synthetic sample numbers to `numbers.json`.
3. Implement retrieval and a pure parser. The existing carrier folders show the adapter
   contract.
4. Record the status codes and wordings you saw in `statuses.json`.
5. Add synthetic fixtures with offline tests.
6. Write the README.
7. Run `npm run generate` to rebuild the catalog and the registry.

Every adapter follows these rules:

- It passes the caller's signal and budget into every request and takes its User-Agent from
  the environment, unless its carrier only answers a browser. `testing/adapterContext.test.ts`
  and `testing/adapterContextSource.test.ts` check both for every registered adapter.
- A number the carrier does not issue is an `InvalidInputError`.
- It declares recognition only when a cheap anonymous HTTP lookup can positively tell a known
  parcel from an unknown one.

[CORPUS.md](CORPUS.md) describes the sample numbers and status records, and
[ARCHITECTURE.md](ARCHITECTURE.md) the rest of what an adapter lives by.

## Keep parcels private

This repository is public. Keep recipient details, capability links, private tracking
numbers and postcodes out of Git, issues and logs. Fixtures are synthetic, and so are the
numbers in bug reports.

## Docs

Keep carrier READMEs short: scope, retrieval, the reasons for non-obvious choices, limits and
how to run the live test. Catalog facts belong in the JSON files and provider results in
[providers/COVERAGE.md](providers/COVERAGE.md).

`npm run generate` writes the README's counts and its pictures in `docs/assets/`. Only
`how-it-works.svg` and `pip.svg` are drawn by hand.

## Versions and releases

The public entry points, result shape, carrier ids, provider names and published data schemas
follow semver. The `/app` entry point is exempt. Fixes are patches. Additive carriers, fields
and exports are minor releases. Removals, renames and changes to the stage vocabulary are
major releases. Version 0.x is the initial API line: until 1.0.0 a removal or rename raises
the minor version, so consumers should pin exact versions.

npm has two channels, and `.github/workflows/release.yml` publishes both as the package's npm
trusted publisher.

- A push to `main` that changes the files a consumer installs is published as `X.Y.Z-main.N`
  under the `next` tag, where `N` is the commit count. A push that only touches Markdown, or
  leaves those files unchanged, publishes nothing.
- Dispatching the workflow with the version in `package.json` validates, builds the package
  and the container images, tags the commit and creates a GitHub release. Publishing that
  version to npm under `latest` is opt-in.

The TRAWL image is published with its upstream and patch source archives, under its AGPL
license.
