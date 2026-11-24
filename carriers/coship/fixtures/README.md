# Fixtures

Replies of `GET www.coship.ca/api/tracking/<number>`, the lookup COSHIP's tracking page reads.

- `arrived.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a parcel from
  Vancouver to Korea whose rows now end at Incheon airport. The recipient's address and the contents are
  replaced by placeholders.
- `not-found.json`: the reply, with HTTP 200, for an invented number: one blank record.
