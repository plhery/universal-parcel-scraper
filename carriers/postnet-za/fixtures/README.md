# Fixtures

Answers of PostNet's tracker, kept as served.

- `tracker.html`: the tracker page's form, cut down to the part around it, with the lookup token replaced by a
  synthetic one.
- `collected.json`: the `aramex` provider's events for the review's waybill in `numbers.json`: created at one
  PostNet, ready for collection at another and collected there.
- `ready-for-collection.json`: the `aramex` provider's events for the collection notice's waybill in
  `numbers.json`: created, then ready for collection.
- `courier-it.json`: the `cit` provider's event for a seven-digit PN waybill Courier IT's archived tracker showed,
  listed in Courier IT's `numbers.json`.

A provider without the number answers with an empty body, which the tests build inline.
