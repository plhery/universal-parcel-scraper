# Intereuropa

Intereuropa parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Intereuropa is a Slovenian logistics group with groupage networks in Slovenia, Croatia, Serbia
and Bosnia and Herzegovina. Pošta Slovenije owns most of it but tracks its own items on its own
tracker; Intereuropa's shipments and numbers are separate. Intereuropa's tracker finds a
shipment by its order number or by the barcode on each of its pieces.

Archived lookups on the Slovenian tracker show order numbers of NRSI and nine digits.
`intereuropa-1` claims that layout with high confidence; no other carrier's corpus or rule has
it. The piece barcodes are SSCCs that carry the sender's GS1 company prefix, so no rule claims
them. The tracker also takes container and air waybill numbers, which belong to shipping lines
and airlines.

## Links

`www.intereuropa.si/si/tracking?pg=tracking&code={number}` opens one shipment, as archived
lookups on Intereuropa's tracker show. The Croatian site links an older form at
`orders.intereuropa.si/ietracking`, which takes a number of up to thirteen characters.

## Why there is no adapter

The main tracker uses two ASP.NET postbacks. The first opens reCAPTCHA; the native
verification callback submits the second, which returns a `pageRedirect` to the tracking
page's `code` query. The browser must keep its guest session through that continuation.
Verification and the redirect are understood, but a current dated-history response is
still needed to establish the adapter's parser contract.

The older form linked by the Croatian site answers
`orders.intereuropa.si/ietracking/GetPaketInfo.aspx?Input={number}` without verification.
It lists an order's piece barcodes, with no status, date or place. It cannot replace the
main tracker's history, so enabled universal providers remain available.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
