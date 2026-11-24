# Instapack

Instapack, run by Immediate Delivery S.L., delivers same-day and next-day parcels with its own
drivers in Spanish cities and Paris. Tracked through the form of the tracking page instapack.es
links to.

## How it works

1. `direct`: posts the form `code=<code>` to `https://back.instapack.es/client-dashboard/seguimiento-de-envios/`.
   A code the tracker knows is redirected to the parcel's page, a signed address valid for a week,
   which the adapter reads next. No session, key or CAPTCHA.
2. `retry`: a lookup that fails to reach Instapack, or hangs, starts again once. The first try gets
   half of the budget.

- The parcel's page is headed with its code, which must be the code asked.
- An unknown code gets the form again, with HTTP 200 and the message `No se localiza ningún paquete`,
  read as not found. The message does not repeat the code; the request for it does. Another
  message leaves the answer open; a redirect anywhere but a parcel's page, a form without a
  message and a block page keep their own kinds.

There is no recognition: no detection rule offers Instapack for a code, so preflight never asks it.

## Status

The page has a panel of the driver's steps, `dd/mm/yy HH:MM - <step>`, a panel of the delivery
incidents, `dd/mm/yyyy HH:MM- <type> - <reason>`, and, once delivered, a panel titled with the
delivery's time and `¡Hemos realizado la entrega!`. Their wordings are staged whole from
[`statuses.json`](statuses.json), else by the shared rules. The panels list their rows in no fixed
order, so the scans are sorted newest first; at the same minute the later step leads, so a round
that leaves as the driver is assigned stands out for delivery.

## Clocks

The page gives wall clocks without a zone. Instapack works in mainland Spain and Paris, which keep
the same clock, so the scans keep their wall clock in `local_time` and Node lookups date them on the
catalog's Madrid clock.

## Notes

- The page shows the delivery address, the driver's name and phone, the parcel count, the sender's
  references and a map of the delivery and the driver; none of it is read. A row never passes on a
  phone number or an email address.
- The tracker finds a parcel by the code its sender gave it, in any case: Instapack's own order ids
  and marketplace numbers such as AliExpress's. The sender's references the page shows are not
  accepted as codes.

## Limitations

- No place, delivery estimate or instants.
- The map holds the wordings the samples showed. Another keeps its wording, staged by the shared
  rules where they can.

## Numbers

Instapack's own order ids seen are fifteen digits, the order's day and a counter, and it also
delivers parcels under the marketplace's number, so no rule names it. The adapter takes 6 to 40
letters and digits with at least one digit. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The form posts the code and the page it leads to expires, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/instapack`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`INSTAPACK_TRACKING_NUMBER` tracks another code, and `INSTAPACK_UNKNOWN_NUMBER` another unknown one.
