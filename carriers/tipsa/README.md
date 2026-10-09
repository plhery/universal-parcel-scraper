# TIPSA

Tracks TIPSA's 22-digit references through the shipment page its `datos_env.php` link
opens. The locator form on tip-sa.com and the `datos_prestashop.php` shop link also ask for
the destination postcode and answer a wrong one like an unknown reference; this link does
not ask.

## How it works

1. `direct`: `GET https://aplicaciones.tip-sa.com/cliente/datos_env.php?id={number}`,
   where the link on `www.tip-sa.com` redirects. A known reference answers a redirect to
   `dinapaqweb.tipsa-dinapaq.com/dinapaqweb/detalle_envio.php` with a service id and a
   `dd/MM/yy` date. An unknown one answers a page that refreshes to `error_env.html`
   ("envío no localizado"): not found, after one request. Any other target or answer is a
   changed page and is not followed. The shipment page is ISO-8859-1.

## Notes

- A 22-digit reference is the charge agency, the origin agency (six digits each) and the
  waybill (ten). The page must repeat the reference in its read-only field and in the
  three hidden agency and waybill fields.
- The history table, the sender (`Remitente`) and the weight (`Kilos`) are read. A
  value masked with asterisks, as the page masks private names, is skipped. The recipient,
  shop reference, postcode, piece count, volume, destination agency and proof of delivery
  on the same page are never read.
- Each history cell repeats its text in a tooltip span; only the visible span is read.
  ParcelsApp reads both, which is why it relays `ENTREGADOENTREGADO`.
- Times: the history keeps Madrid time for every agency, Portuguese ones included, and
  `timezone` is `Europe/Madrid`. The proof of delivery shows the local time: the same as
  the history's delivery row for deliveries in Spain, an hour earlier in Portugal.
- Labels map through `status.ts`; others fall to the shared Spanish wording rules, and
  stay unmapped when those don't know them either.
- Detection only suggests TIPSA: CTT Express numbers share the agency, agency, waybill
  layout, and every six-digit agency code seen so far starts with 0. Recognition asks
  TIPSA first for such numbers.

Links to tip-sa.com's home page and its `datos`, `datos_env` and
`datos_prestashop` shipment pages name TIPSA; its other pages name none.

## Limitations

- Ten-digit waybills can't be looked up without their agency codes; recognition answers
  them as unknown without a request.
- References of the `000010` account stay ambiguous with CTT Express, and recognition
  asks TIPSA first. Any other reference starting `00` matches CTT Express's
  high-confidence rule and is filed there until a universal provider names TIPSA.
- An expired history and an unknown reference get the same not-located page.

## Testing

`npm run test:carriers:live -- carriers/tipsa` sends a well-formed
unknown reference. Set `TIPSA_TRACKING_NUMBER` to a real reference to read one history.
