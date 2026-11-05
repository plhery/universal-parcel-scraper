# KargoTurk

The adapter reads KargoTurk's public guest tracking page and binds both the visible barcode
and the labelled customer barcode. Its shared numeric formats add no detection rule; explicit
selection and tracking links reach the native lookup.

`online.kargoturk.com.tr/tracking?har_kod={number}` needs no account or verification step. Only
the specific normal tracker error view becomes not-found. Blocked pages, changed tables and
rate limits remain distinct, with enabled universal providers available for fallback.

The scan table is oldest first. The adapter reverses it without assigning an offset to its
wall clocks. A return to the origin branch remains a depot movement; only the explicit return
to the sending company establishes a completed sender return. Communication and carry-over
notices stay unstaged. The current summary must agree with a known closing activity.

Only operation, branch and scan clock columns are projected. Courier names, recipient and
shipper fields, addresses, signatures and proof links are omitted.

## Testing

Supply `KARGOTURK_TRACKING_NUMBER` and `KARGOTURK_UNKNOWN_NUMBER` privately:
`KARGOTURK_RETURNED_NUMBER` additionally checks a completed sender return.

```sh
npm run test:carriers:live -- carriers/kargoturk/adapter.live.test.ts
```
