# Fixtures

Replies of CargoMini's tracker, `api.kargomkolay.com/v1/tracking/<number>`.

- `delivered.json`: the reply for a public sample in `numbers.json`, a consignment flown into Türkiye,
  cleared and delivered by Kolay Gelsin. The recipient's masked name, postcode and town and the
  shop's order reference are placeholders.
- `not-found.json`: the problem reply, with HTTP 404, for a synthetic number the tracker does not
  know.
