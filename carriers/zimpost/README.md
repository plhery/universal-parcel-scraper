# Zimpost

Zimpost parcels use enabled universal providers. There is no dedicated adapter.

Zimpost (Zimbabwe Posts) is Zimbabwe's designated postal operator. Its site is zimpost.co.zw.

## Numbers

Its items carry UPU S10 numbers ending `ZW`, which postal detection reads. No public page shows one, so there is no
rule of its own. The public client also offers a foreign-post example; its presence does not
establish a current shipment result or replace the issuing post's detection.

## Why there is no adapter

Its tracker reads an open JSON endpoint, `GET /api/track` on www.zimpost.co.zw with the number in `number`, without
a session or CAPTCHA. Its success payload uses UPU IPS scan data, with GMT clocks and separate
offsets in hours. The client expects structured success or error replies. Native retrieval
still needs a current whole-item history control to distinguish an absent item from an
unavailable upstream; a responsive home page and a JSON error alone do not settle that.

## Links

Its tracker opens in an overlay on the home page with no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
