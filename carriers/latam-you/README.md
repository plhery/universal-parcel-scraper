# Latam You

Tracks Latam You (拉美邮) orders, a line from China to Latin America, through the lookup its
guest tracker at latamyou.com makes.

## How it works

1. `direct`: `GET /RegisteredPortal/shipmentOrderTrace?inputNo=` with the order number. No
   session or token is needed.
2. `retry`: the same request once more when the first fails to reach the service or hangs. The
   first try gets half of the budget.

## Notes

- Only `obj` says whether the order exists. An empty list is the tracker's own answer for an
  order it does not hold, and reads as not found. `totalCount` stays 0 even when rows come back,
  so it is ignored.
- Every row names its order as `sourceNo`. A reply with a row for another order is inconclusive.
- Row times carry their offset (`GMT+08:00`) and are read as instants with it.
- A row's description is its state's label. The row's second line, the line's fixed confirmation
  or the Cainiao step code of the last-mile rows, is left out, as is the operator who wrote it.
- State 2000 ("Other") is the state list's catch-all and has no stage, so it keeps the stage of
  the row before it.
- The destination country is the two letters after `LTY`, when they are one of the countries the
  site serves.

## Limitations

- The tracker also takes merchant and tracking numbers, but its reply names only the order, so
  a lookup by another number could not be bound to it. Only `LTY` order numbers are accepted.
- The guest reply has no last-mile tracking number, location, weight or delivery estimate, so no
  hand-off to the delivering carrier is made.

## Testing

`npm run test:carriers:live -- carriers/latam-you`

Set `LATAM_YOU_TRACKING_NUMBER` outside the repository to check another order, and
`LATAM_YOU_UNKNOWN_NUMBER` to check that an unknown order reads as not found.
