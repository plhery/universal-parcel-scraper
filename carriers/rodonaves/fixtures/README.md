# Fixtures

Replies of the two lookups Rodonaves's tracking page makes, with the masked sender and recipient
names replaced by placeholders.

- `brudam-delivered.json`: Brudam's reply for the second public sample in
  [`numbers.json`](../numbers.json), a delivered Rodo Aéreo ECO minuta with its flights.
- `brudam-billed.json`: Brudam's reply for the first public sample, a delivered minuta whose
  record is mostly billing entries and customer-service tickets.
- `brudam-not-found.json`: Brudam's reply, with HTTP 200, for an invented number. The road
  system answers the same number with HTTP 204 and no body.
- `rodo-synthetic.json`: a synthetic road-system reply, in the shape the tracking page's script
  reads. No public road protocol number is known.
