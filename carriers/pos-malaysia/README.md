# Pos Malaysia

Tracks Pos Malaysia and Pos Laju items through the anonymous API used by the official tracking app.

Besides MYPM barcodes and MY postal items, it takes Pos Laju consignments, three letters, nine digits and MY, whose ninth digit is the S10 check digit of the eight before it, and inbound postal items under their origin's S10 number, which the tracker follows to delivery in Malaysia. Detection names Pos Malaysia only when that check digit holds; the adapter still accepts a consignment whose digit fails.

## How it works

One bounded JSON request supplies the number and a fresh request identifier. No browser, account or cookie is needed. The response must contain exactly one matching consignment.

## Notes

Null or empty history is inconclusive: unavailable history does not prove shipment absence. Error rows and malformed scans cannot silently expose an older scan as current.

The delivered summary is authoritative. If the latest scan does not establish delivery, an undated summary snapshot preserves that evidence without borrowing an older scan's time. The return scan of an item sent back to its sender reads as returned. Unknown scan summaries remain visible without an inferred stage. An office reading "In Transit" is a status, not a place, and is dropped.

Offsetless clocks receive Malaysian time only when both route countries explicitly identify a domestic Malaysian journey. International or unlocated scans keep their clock as a wall clock (`local_time`), since a relayed scan can be on another country's clock; invalid dates remain provider text. The source supplies current scans first; that order is preserved whenever any clock is unresolved.

## Limitations

The adapter retains a bounded history and coarse facility names. It excludes personal contact blocks, addresses and proof-of-delivery material. It returns no ETA. An international scan names no zone, so a consumer dates it on a deduced clock (`dateLocalClocks`).

## Testing

Run `npm run test:carriers:live -- carriers/pos-malaysia`. Set `POS_MALAYSIA_TRACKING_NUMBER` for available history or `POS_MALAYSIA_DELIVERED_TRACKING_NUMBER` for a delivered item. Supply parcel inputs outside the repository.
