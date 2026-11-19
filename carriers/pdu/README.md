# PDU

PDU (友递联, Parcel Delivery Union) is a Shanghai logistics company that carries Chinese
e-commerce parcels and hands them to last-mile carriers abroad under its own number. The adapter
reads the service behind its public tracking page over plain HTTP.

## Numbers

A parcel to Colombia carried the destination's country code, eight digits and PD. A low rule
offers PDU for that shape; other destinations' numbers have not been seen. Recognition asks PDU,
because the shape also fits Colis Privé's and only the tracker can tell them apart.

## How it works

1. `direct`: posts the number, as a one-item JSON array, to
   `www.pduni.com/system/api/logistics/traceByWeb`, which the tracking page asks with up to 50
   numbers. No session or token is needed.

The reply counts the numbers asked by state and holds each number's record: its state
(`trackStatus`), origin and destination countries and its scans, newest first. Each scan has a
state, the last-mile carrier's code and wording (`ENT,Entregado`), its wall clock and the UTC
offset PDU states for that clock, and a Beijing clock.

## Notes

- A scan's time is its wall clock with the offset PDU states beside it. A scan without one is
  dated by its Beijing clock, which the replies give for the same instant.
- The wording after the last-mile carrier's code is the description. The scan's state sets its
  stage, except where the wording says more: `DELIVERY` covers national transit as well as the
  round, so only "Salida a Ruta" is out for delivery, and the first scan's "not found in last
  mile or customs process" means no last-mile record yet.
- A delivered, returned or problem state of the parcel sets its stage when no scan carries it.
- The page files a number without a state under "not found". A record with no state and no scan,
  `NOT_FOUND`, or an empty reply that counts the number as missing is not found; a reply without
  the requested number is indeterminate.

## Limitations

- The not-found reply comes from the page's script, not from a live lookup.
- The delivery photo needs the recipient's phone number and is not read.

## Testing

`npm run test:carriers:live -- carriers/pdu` with `PDU_TRACKING_NUMBER` and optionally
`PDU_UNKNOWN_NUMBER` set outside the repository.
