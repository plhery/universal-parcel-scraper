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

`npm test` runs at most four test files at once (`maxWorkers` in `vitest.config.ts`), whatever
the machine, so several checkouts can test side by side. `--maxWorkers` changes it for one run.
`npm run test:scripts` keeps to four files too (`--test-concurrency`).

## Fix a carrier

Start with the carrier's README in `carriers/<id>/`. It says how the site is read and which
choices were deliberate. Then reproduce the problem offline: add or adjust a fixture,
make the parser test fail, and fix it.

Live tests contact the carrier, so run them only when you mean to:

```sh
npm run test:carriers:live -- carriers/<id>
```

They read private inputs from environment variables or ignored files. Do not turn a blocked
or inconclusive response into a passing test.

A scheduled canary run looks up wrong numbers through every public adapter and provider. Its
issue is open while a check fails two days running on a page that answers, or a carrier has
not answered for two weeks, and its body lists every failing check with the day it started.
That issue is a good place to find work.

## Add a carrier

```sh
npm run carrier:new -- --id example --name "Example" --color "#0055a4" --canary-url https://example.com/
```

The script writes the folder. `--color` is the main colour of the carrier's logo or site: the
apps paint the carrier's parcels with it, and the grey is kept for the unknown carrier. From there:

1. Fill `carrier.json`: the portal facts, the tracking links and the detection rules.
   `portal.searchUrl` is the page, with no number in it, where someone on a phone types a
   tracking number. Open it at phone size before you set it: some trackers only show their
   field on a desktop, and a field that shows only after a tap needs its controls in
   `searchFieldReveals` ([trackingSearchPages.ts](testing/trackingSearchPages.ts)) for the
   weekly check. `portal.helpUrl` is the carrier's own help or contact page for someone
   receiving a parcel, which the parcel's page links once it stops moving: leave it out
   rather than link a shipper's contact form, a tracking page or another site.
2. Add public or synthetic sample numbers to `numbers.json`.
3. Implement retrieval and a pure parser. The existing carrier folders show the adapter
   contract.
4. Record the status codes and wordings you saw in `statuses.json`. A `status.ts` that
   declares a `statusMap`, with the codes it leaves unmapped on purpose, is registered in
   [statusMaps.ts](core/catalog/statusMaps.ts).
5. Add fixtures with offline tests: a public sample's reply or a synthetic one.
6. Write the README.
7. Add a case for the tracking link to `testing/trackingLinkCases.ts`, with the address the
   page ends on and wording only the carrier's tracker shows, both read from the rendered
   page. A link no case can open gets its reason in `uncheckedTrackingLinks` instead.
   `npm run test:tracking-links -- -t <id>` opens it.
8. Run `npm run generate` to rebuild the catalog and the registry.

Every adapter follows these rules:

- It passes the caller's signal and budget into every request and takes its User-Agent from
  the environment, unless its carrier only answers a browser. `testing/adapterContext.test.ts`
  and `testing/adapterContextSource.test.ts` check both for every registered adapter.
- A number the carrier does not issue is an `InvalidInputError`.
- It declares recognition only when a cheap anonymous HTTP lookup can positively tell a known
  parcel from an unknown one. When its rules offer numbers that lookup cannot bind as a whole,
  `tracking.recognition.pattern` names the ones it can. `tracking.recognition.rank` orders the
  carriers asked about one number, highest first, and no two carriers share one: when yours
  collides, `npm run generate` names the free ranks nearby.
- Its carriers set `tracking.browser` when a lookup can open a browser through the environment's
  `trawl` or `browserExecutablePath`, or a remote one. `testing/adapterBrowserSource.test.ts`
  reads that from the adapter's code, and checks that exactly those carriers list a browser
  step: `trawl` for the browser service, `browser` for a Chromium, or DPD's `page`.

[CORPUS.md](CORPUS.md) describes the sample numbers and status records, and
[ARCHITECTURE.md](ARCHITECTURE.md) the rest of what an adapter lives by.

## Pull requests

The checks on a first pull request wait until a maintainer approves them. Run the commands
under [Setup](#setup) in the meantime.

`main` moves several times a day, so generated files conflict on most rebases. Take main's
side for `generated/`, `data/catalog.json`, `data/coverage-summary.json`,
`data/detection-golden.json`, `docs/assets/` and the README's counts, then run
`npm run generate` and `npm run generate:golden` again instead of merging them by hand.

Leave the version alone; it is raised after the merge. [Peek](https://github.com/plhery/peek-delivery-tracker),
the app built on this package, needs a database migration for a release that adds a carrier
id or input. The maintainers write it when they merge, so a carrier needs no pull request there.

By sending a contribution, you license it under the [PolyForm Noncommercial License 1.0.0](LICENSE)
like the rest of the code, or under [AGPL-3.0-only](LICENSES/AGPL-3.0.txt) for the catalog and
pattern files [NOTICE](NOTICE) lists, and you grant Paul-Louis Hery a perpetual, worldwide,
non-exclusive, royalty-free, irrevocable licence to use, copy, modify and distribute it, and to
license it to others under other terms, commercial ones included. You keep your copyright. Send
only work you have the right to license this way.

## Public and private data

This repository is public. What a public page shows can go in, cited by that page's URL: a
number, its postcode, a tracking link, the carrier's reply.

You can post one of your own parcels in an issue, with its postcode, if you are happy for it
to be public. It then counts as a public sample cited by the issue, and the carrier's reply,
which may show your name or town, can become a test fixture. If you would rather keep it
private, say so in the issue and a maintainer will arrange another way to send it.

Numbers, postcodes, links and recipient details from a deployment stay out of Git and issues,
and so do credentials.

## Docs

Keep carrier READMEs short: scope, retrieval, the reasons for non-obvious choices, limits and
how to run the live test. Catalog facts belong in the JSON files, measured results in
[the benchmark](benchmark/README.md) and the evidence provider order follows in
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
  leaves those files unchanged, publishes nothing. Pushes publish one at a time, and a push still
  waiting gives way to a newer one, which contains it. A run that ends green has published its
  own commit only: when main moved on while it waited for its checks, or when it published
  nothing, its summary says so, and the newer commits publish from their own run.
- Dispatching the workflow with the version in `package.json` builds the package and the
  container images, tags the commit and creates a GitHub release. Publishing that version to
  npm under `latest` is opt-in.

Both wait for the CI and secret scanning workflows to pass on the same commit, and publish nothing
when either fails. A dispatch on a commit they have not run on fails until they are dispatched on
it. After rerunning a failed run of either, rerun the release run's failed jobs.

Raise `package.json` and `package-lock.json` together. `npm run build` writes that version
into the source OpenAPI document and its packaged copy. The `npm version` hook rebuilds
after assigning the final version, including prereleases.

The TRAWL image is published with its upstream and patch source archives, under its AGPL
license.
