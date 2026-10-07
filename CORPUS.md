# Corpus

Two kinds of evidence sit in every carrier folder: the numbers detection is tested on and the
statuses the stage mapping is built from. Both are data, checked in next to the code that
reads them.

## Tracking numbers

`numbers.json` records sample numbers, where each one comes from and what detection should
answer for it. A sample is either public, with its source, or synthetic, with how it was
derived. [numbers.schema.json](core/testing/numbers.schema.json) defines the record.

Source access distinguishes a retrieved page from an indexed excerpt; `dateKind` says
whether a source date belongs to a publication, comment or carrier reply. Optional context
keeps the reported service, identifier role and evidence assessment separate from `expect`.
Candidates are public reports, not confirmation of issuance or current trackability. A
`confirmed` number is one the carrier's own tracking knew. Scope reviews, uncertain
attribution and auxiliary references require `quarantine: true` and never act as positive
oracles. Keep their inputs intact, including spaces, case and leading zeroes.

Quarantine means unresolved evidence, not a claim that a number is fake. It is for a number
whose carrier or role is in doubt. A report that names its carrier stays out of quarantine
even when detection does not know the shape: `expect` records that gap, and the gap is what
to fix. The suffix of a checksum-valid S10 number names the postal operator that issued it,
which is attribution enough for a report of one; the delivery carrier can differ. A
documentation placeholder whose check digit fails is a negative. Matching official history
resolves a quarantined record; an absent result can reflect expired records.

Every quarantined record names its reason in `context.assessment`:

- `scope_review`: a real number of a service or network the folder's carrier may not cover.
- `review`: the source does not establish the carrier or what the identifier is.
- `quarantine`: the carrier or the source disputes the number.
- `auxiliary`: a related reference that is not a tracking number.

A record that nothing could settle is removed, not kept in quarantine.

Relationships link a child to its master, a return to its outward shipment or a pickup
booking to its parcel. Each cites its own evidence and targets another record in the same
carrier corpus. A shared prefix or appended counter does not establish a relationship.

A numeric shape that several carriers share only suggests a carrier. A distinctive family
can identify one. Checksums filter or prioritize candidates; they do not establish network
ownership or shipment existence. The corpus tests reject collisions nobody declared in
[collisions.json](core/detection/collisions.json) and make sure every detection rule has an
example.

A record whose own carrier detection does not offer is a gap, and
[gaps.json](core/detection/gaps.json) has to declare it. `by_design` and `collision` say why
the gap stays; `open` ones are the worklist.

A collision or gap declaration that no record needs any more fails the sweep, so both lists
only hold what is still true.

```sh
npm test -- core/testing/detectionSweep
```

That run checks the corpus against its golden replay. After a deliberate change,
`node scripts/detection-golden.mjs` rewrites [detection-golden.json](data/detection-golden.json).
The app replays that file and also [checksum-vectors.json](data/checksum-vectors.json), synthetic
inputs for every checksum validator that `node scripts/checksum-vectors.mjs` rewrites.

## Statuses

`statuses.json` records the status codes and wordings seen from a carrier. Each entry names
the stage it means and says how that was confirmed, by a live reply or the carrier's own
documentation for instance. A note explains the entries that are not obvious.

Some adapter tests replay these entries against the carrier's status map. Wording no carrier
map covers falls to the shared classifier in [core/status](core/status/wording.ts), which
has its own tests against audited histories.

## What never goes in

Private live-test numbers do not belong in the corpus. Provider and parser fixtures bind to
synthetic identities, and leave out recipient details and access credentials. Opaque tracking
page keys and capability URLs stay outside Git even when a search engine indexes them.
