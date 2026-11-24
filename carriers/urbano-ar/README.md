# Urbano Argentina

Urbano Argentina is a courier and e-commerce delivery company in Buenos Aires. It has its own
tracker and numbers, apart from [Urbano](../urbano/README.md) in Peru and Ecuador. Tracked through
the lookup page its tracking form opens and the scan list that page loads.

## How it works

1. `direct`: `GET https://apis.urbano.com.ar/cespecifica/?shi_codigo={shipper}&cli_codigo={code}`,
   the page the form at urbano.com.ar/segui-tu-envio opens, then, for each row with a guide, one
   `POST https://apis.urbano.com.ar/cespecifica/class/especifica_controller.php` with
   `accion=getDetalle` and the row's `data` attribute as `param1`, the request its magnifier makes.
   No session, token or CAPTCHA: the form's reCAPTCHA only gates its button.
2. `retry`: one more read after one that fails to connect or hangs. The first gets half of the
   budget.

- The form splits the number: a number starting with `DVPQ0101`, Mercado Libre's, belongs to
  shipper 2273 and the rest is its code; any other starts with the shipper's four digits. The
  shipper is sent as six digits.
- Each row repeats the shipper and the code, which must be the ones asked.
- An unknown code gets one row with client record 0, no product and "Sin información", which reads
  as not found. A code with a client record but no product is one the shipper registered that has
  no guide yet; it reads as listed without history. A page without the tracker's title is a block
  page or a changed tracker.

## Notes

- Scans carry a two-letter code before their wording ("DL - Su envio fue entregado"). The code sets
  the stage: the return wording ends with its reason.
- Scans give a day and a minute with no zone, kept as wall clocks. The page numbers them oldest
  first; scans of one minute keep that order.
- The branch name, without its number, is the scan's location.
- The masked name on the lookup page and the masked street, phone and town on the scan list are
  never read, nor the delivery photo.

## Limitations

- A number reaches the adapter when it is filed under Urbano Argentina: a shipper's four digits
  followed by a code is a shape many carriers share, so no rule claims it and preflight does not
  ask it.
- International shipments use another tracker, internacional.urbano.com.ar, which the adapter
  does not read.

## Numbers

The tracking form takes the shipper's four digits followed by the shipment's code, or `DVPQ0101`
followed by a Mercado Libre code. The public samples, archived lookups on the tracker, and their
sources are in [`numbers.json`](numbers.json).

## Links

The lookup page carries the shipper and the code in two parameters, and a tracking link names one
parameter, so there is no tracking link.

## Testing

`npm run test:carriers:live -- carriers/urbano-ar`, which tracks the first public sample unless
`URBANO_AR_TRACKING_NUMBER` is set, and an invented code unless `URBANO_AR_UNKNOWN_NUMBER` is.
