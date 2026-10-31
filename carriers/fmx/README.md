# FMX

FMX parcels use enabled universal providers. There is no dedicated adapter.

FMX (FMX (M) Sdn Bhd), which brands its site eFMX, is the Freight Mark group's express courier in Malaysia. It
delivers domestic parcels next day to the main towns and in two to three days to rural areas, and clears
cross-border e-commerce imports at its KLIA gateway. Its site is fmx.asia.

## Numbers

Its consignment numbers are `MYX` and ten digits, as its tracking page for a real import and the demo data in
its app guide show. `fmx-1` suggests them at low confidence, since one real example is known. The tracker's
input hint shows `MYC` and nine digits, but no real number has that shape, so no rule takes it. The tracker
also takes shippers' own references.

## Why there is no adapter

Its tracker is an open HTML page without a session or CAPTCHA:
`GET www.fmx.asia/result_detail.php?p=1&conno={number}`. A found consignment shows its references, pickup and
delivery dates and its scans, on Malaysian clocks without an offset. An unknown number gets HTTP 200 with
"Consignment Data Generated, Awaiting for Handover" and no tracking number block: it reads like a status,
but the tracker has no data, so an adapter must read it as not found. No adapter has been written for it yet.

## Links

The tracking page opens numbers from its `conno` parameter, also under `/cn/`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
