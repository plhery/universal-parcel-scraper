# DPD Greece

DPD Greece parcels use enabled universal providers. There is no dedicated adapter.

DPD Greece is the DPD network's national carrier in Greece. Its site, www.dpd.gr, opens its
tracker at services.dpd.gr, the same Speedy platform page DPD Romania's tracker uses.

## Numbers

DPD Greece publishes no waybill format, and no public page shows one of its waybills, so there is
no rule.

## Why there is no adapter

services.dpd.gr serves a Cloudflare challenge before its tracker, whose form then asks for its own
Turnstile token. It shows MySpeedy's public page, `myspeedy.speedy.bg/pub/web-site/<waybill>`, in a
frame, the service the [Speedy](../speedy/README.md) adapter reads without a token. DPD Romania's adapter reads
the anonymous endpoint behind MyDPD instead. DPD Greece runs the same MyDPD at mydpd.dpd.gr, with
the tracker script DPD Romania's serves, which asks the same
`/rest/public/track?id=<waybill>&language=en` path. Unlike DPD Romania's, its settings publish a
Turnstile site key, so its tracker sends a Turnstile token in the `X-SL-Turnstile-Token` header
with every lookup and reads HTTP 406 with a `turnstile-failure` entry as a refused token.

Asked without a token, the endpoint answers a made-up waybill with HTTP 404 and MyDPD's "the
requested resource does not exist" page, the page it also gives a path that does not exist, as
DPD Romania's MyDPD gives its own not-found page for both. It answers a DPD Romania waybill with
an empty object, which the tracker script cannot show. No DPD Greece waybill has been seen, so
whether a shipment's answer needs the token is not known, and the adapter waits for one to
confirm the path, the token and the reply.

## Links

Tracking links carry the number as `shipmentNumber`, on the `tracking` page of services.dpd.gr or
on the `track-shipment` page of www.dpd.gr.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
