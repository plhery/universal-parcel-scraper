# Servicios Postales del Ecuador

Servicios Postales del Ecuador (Empresa Pública de Servicios Postales del Ecuador), which replaced
Correos del Ecuador, is Ecuador's national post. Gintracom delivers its parcels to the door within
Ecuador. Its Sí Postal tracker shows the history of a postal item in Ecuador, including the
sending post's scans for an item from abroad.

## Numbers

Servicios Postales del Ecuador gives items UPU S10 numbers ending `EC`, as its tracker's example
shows, and items from abroad keep the sending post's number. Generic postal detection handles
both, so no rule for Servicios Postales del Ecuador claims them and preflight never asks the
adapter. The adapter takes S10 codes with a valid check digit. The samples and their sources are
in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: `GET https://sipostal.serviciopostal.gob.ec/Navegacion/Tracking`, an ASP.NET page,
   for its form's state, then a `POST` of the form back to the same address with the code in
   `ctl00$MainContent$txt_codigo_envio` and `__EVENTTARGET` naming the Consultar button, as the
   button's postback sends it. The form's reCAPTCHA field goes empty, which the tracker accepts.
   No cookie or token is needed.
2. `retry`: an attempt that fails to reach the tracker, or hangs, is made once more within the
   budget, with a fresh form. The first try gets half of the budget.

The answer has a card for the code, which repeats it, and the code's history under a heading that
names it, newest first. Both must name the whole code. A scan has a day, a clock, its wording and
the office or country where it was made. The day comes as "Sep. 9, 2024" or "09/Sep/2024", with
Spanish month abbreviations; anything else is a changed page.

- A code the tracker holds nothing for gets a card saying it was not located, which is not found.
- The form sent back without a card is a search without the code when the page asks for one, and
  otherwise a challenge: the form holds a reCAPTCHA the tracker could start to require.
- A firewall or bot-check page, even with HTTP 200, or a 403 is a challenge and a 429 a rate limit.
  A redirect, a 404, a 503 and the site's "Oops" error page are transport failures, and any other
  page is a changed page.

## Notes

- A delivery's wording goes on with "Recibido por:", the receiver's name and their cédula. The
  adapter drops that part, and any run of ten digits or more from every wording; the status map
  reads the delivery without them.
- The card repeats the newest scan, receiver included, and adds a note about paying the Sí Postal
  notification fee that shows even on a delivered item. Neither is read.
- "Despachado a oficina" names the office the item was sent to, while the scan's place is the one
  it left. "Proceso de revisión aduana - importación" ends with the kind of check. The map reads
  both by their start.
- The sending post's scans name its country in ISO's style, "United States of America (the)";
  the article is dropped. Receipt at Ecuador's office of exchange gives Ecuador as the destination.

## Clocks

The page gives no offset. Mainland Ecuador keeps UTC−05:00 and Galápagos UTC−06:00, office names
do not say which, and the sending post's scans are on its own clock. Every scan therefore keeps
its wall clock in `local_time`, and a lookup dates it on a zone it deduces, its place first.

## Limitations

- No ETA, weight, service, sender, recipient or proof of delivery.
- Only an item from the United States delivered in Ecuador has been seen. Outbound items, returns,
  failed attempts and held items have not; their wording stays visible, staged by the shared
  wording rules where they can.
- The tracker takes up to five codes at once; the adapter posts one.

## Links

The tracker takes the code in a posted form, so no address opens one item.

## Testing

```sh
CORREOS_ECUADOR_UNKNOWN_NUMBER=<made-up S10 code> npm run test:carriers:live -- carriers/correos-ecuador
```

The test reads the public sample from `numbers.json` unless `CORREOS_ECUADOR_TRACKING_NUMBER`
gives another code.
