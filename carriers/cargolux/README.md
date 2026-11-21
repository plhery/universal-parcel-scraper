# Cargolux

Cargolux is Luxembourg's all-cargo airline. The adapter tracks its air waybills, and those of
Cargolux Italia, through the JSON service behind the track-and-trace page at cargolux.com.

## How it works

1. `direct`: `GET <service>/api/track/awbs/?numbers=<prefix>-<serial>`, with no account, cookie or
   token. The reply holds the waybill's summary and its events grouped by airport. A read that
   fails to reach the service, or hangs, is sent once more.

## Notes

- The page accepts the prefixes 172 (Cargolux) and 356 (Cargolux Italia), so the adapter does too.
  A serial without a prefix is read as Cargolux's. The service itself answers for any airline's
  prefix with an empty record, which would read as not found.
- Events carry their station's offset, which is kept. The tracker names each event by its
  Cargo-IMP code; the wording comes from the page's own translations, as
  [statuses.json](statuses.json) says.
- Steps the tracker has not processed yet are planned steps with their own wording, kept as
  planned events rather than scans.
- A pickup notice, documents handed over or a delivery away from the waybill's destination is a
  step on the way. A waybill delivered in parts is delivered once its delivered pieces reach its
  total; until then its latest other stage leads.
- A flight number ending in Z, or one the tracker marks as a truck, is a road feeder service.
- A waybill the service does not hold comes back with an empty summary and no airports, read as
  not found. One it refuses is listed as invalid.
- The agent, the goods' description, handling codes, weights and volumes are not read.

## Limitations

- The service lives on a default Azure Container Apps domain that the page names in its
  `data-track-and-trace-simple-module` settings as `apiUrl`. A move would show as a transport
  error until the address is updated.
- The page opens a waybill from `#numbers=<prefix>-<serial>` only with the hyphen, while the
  catalog link uses the number as typed, so the catalog links to the search page alone.

## Numbers

A Cargolux air waybill is its prefix and an eight-digit serial whose last digit is the first
seven modulo 7. Detection has no rule, since every airline's waybills share the format. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/cargolux`

The live test tracks the public sample in `numbers.json`; `CARGOLUX_TRACKING_NUMBER` tracks
another waybill, and `CARGOLUX_UNKNOWN_NUMBER` checks the not-found answer with another number.
