# Recíbelo

Recíbelo is a Chilean last-mile carrier based in Santiago, with same-day, suburban and rural
delivery for online shops.

## How it works

1. `direct`: asks `app.recibelo.cl/api/check-package-internal-id?internal_ids[]=<number>`, as the
   tracking page's script does. The reply lists the parcels under the number, each with its current
   status and its statuses, newest first.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- Every parcel in the reply must name the number asked; another parcel's reply leaves the answer open.
- A number the tracker holds no parcel under gets "Paquetes no encontrados" with HTTP 404, read as not
  found. Another 404 is a moved tracker, a block page a challenge, and a reply of another shape a
  changed one.

## Notes

- Parcels for several recipients can share a number; the tracking page then asks the visitor to pick
  their name. The adapter answers only when one parcel remains after the page's own filter, which
  hides parcels whose status is No aceptado, Sin comuna or Falta Información.
- Status times are Chile's wall clock without a zone and are kept in `local_time`.
- Statuses carry no code and are staged by their whole wording from [`statuses.json`](statuses.json);
  the page's script lists its steps and the statuses it hides.
- The recipient's name is never read.

## Limitations

- No places, estimate or proof of delivery: the reply has none.
- Numbers several recipients share leave the answer open.

## Numbers

Recíbelo tracks a parcel by its envío number. The public samples are nine digits, a digit run many
carriers share, so detection has no rule. The adapter takes 5 to 40 letters, digits and hyphens with
a digit. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`recibelo.cl/seguimiento/?codigo=<number>` and `recibelo.cl/seguimiento/<number>` look one number
up, and the library reads the number from either address.

## Testing

`npm run test:carriers:live -- carriers/recibelo`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`RECIBELO_TRACKING_NUMBER` tracks another number, and `RECIBELO_UNKNOWN_NUMBER` another unknown one.
