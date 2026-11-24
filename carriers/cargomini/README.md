# CargoMini

CargoMini is the tracked cross-border service of KargomKolay, a brand of DRN Lojistik A.Ş. in
Istanbul. It gives each consignment its own number, flies it between Türkiye and other countries
and hands it to a local carrier for the last mile, such as Kolay Gelsin in Türkiye or GLS, DHL
eCommerce or Saudi Post abroad. KargomKolay Global's imports into Türkiye, for marketplaces such as
N11, use the same tracker. KargomKolay's express shipments travel on DHL, UPS, FedEx and TNT labels
and belong to those carriers.

## Retrieval

The adapter asks `GET api.kargomkolay.com/v1/tracking/<number>`, the JSON lookup the tracking page
at `tracking.cargomini.com` makes, without a session or CAPTCHA. It keeps a reply only when it
repeats the number asked. Events carry an instant with its offset, so they keep it. They are staged
by the tracker's event code, whose names come from the page's script; special events and the
last-mile carrier's scans, which share one code each, by their whole wording. An event without
wording takes the page's title for its code.

The last-mile carrier's number becomes the delivery tracking number. The carrier itself is named
only when its name and link are one catalog carrier's and that carrier's rules or link fit the
number; Kolay Gelsin has no rule, so its numbers stay without a carrier.

The sender, the recipient's masked name, postcode and town, the shop's order reference and the
weight are never read. The estimated delivery date is left out because no reply has shown its
format.

An unknown number gets HTTP 404 with a problem reply titled Not Found, which reads as not found. An
empty 404 is a missing route, and browser checks, refusals, rate limits and pages in place of JSON
keep their own kinds.

## Numbers

The public samples are twelve digits and TR. KargomKolay does not document the layout, so no
detection rule offers CargoMini and the shape is a declared gap; the adapter answers explicit
selection.

## Links

The tracker takes the number as its path, so `tracking.cargomini.com/<number>` opens one
consignment.

## Testing

```sh
npm run test:carriers:live -- carriers/cargomini
```

`CARGOMINI_TRACKING_NUMBER` and `CARGOMINI_UNKNOWN_NUMBER` replace the public sample and the
synthetic number.
