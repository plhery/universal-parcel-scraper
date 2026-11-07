# Paxel

Paxel parcels use enabled universal providers. There is no dedicated adapter.

Paxel (PT Global Unggul Mandiri) is an Indonesian courier for same-day and instant deliveries
within and between cities, collected and delivered by its own couriers.

## Numbers

A Paxel AWB is EM and a dot, ten capital letters and digits, then the shipment date, one digit
and six capital letters and digits, joined by hyphens. Paxel's blog and the tracker's
placeholder describe it. The library compares numbers without dots and hyphens, so `paxel-1`
claims EM, ten letters or digits, an eight-digit date starting with 20, one digit and six
letters or digits. No other carrier's numbers or rules use that layout.

## Links

The canonical Indonesian page, `paxel.co/id/lacak-pengiriman?awb_req={number}`, fills the
tracker's form and submits it. Links restore the AWB's printed dot and hyphens after
normalization. The older Indonesian `/id/track-shipments` address redirects without
preserving the number. Pasted links from that address and the English tracker remain readable.

## Why there is no adapter

The public page can require Cloudflare verification. TRAWL's ordinary browser tiers can
reach the form and complete its automatic submission. The page posts the printed numbers
and its session's form token to `/id/lacak-pengiriman`, then renders the result.

The Paxel Android app (`com.paxel`) shows the history of the signed-in account's own
shipments only, and shares the web tracker's link for any other. A dedicated public-page
found-shipment parser is not implemented, so Paxel stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
