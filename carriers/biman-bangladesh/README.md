# Biman Bangladesh Airlines

Biman is Bangladesh's national airline. Its cargo site sends air waybill tracking to CHAMP's
freight.aero tracker, which the adapter reads through the browser tracking service.

## How it works

1. `trawl`: the browser service opens `https://www.freight.aero/tracking.asp#<waybill>` in a fresh
   context, picks Biman in the page's airline list, enters the serial and asks. The page shows a
   reCAPTCHA v2 checkbox; the service's audio solver answers it, or during the solver's pause the
   checkbox is clicked alone. Once it calls back, the page posts the lookup to
   `https://www.freight.aero/tracking_service.asp`. Only that lookup for the whole waybill reaches
   the tracker, once, and the service hands back the waybill's route, status and events.

The lookup is refused without a reCAPTCHA token, so there is no plain HTTP step. No account,
cookie or paid solver is needed.

## Notes

- [freightAero.ts](freightAero.ts) reads any airline the tracker lists; Biman passes its code and
  prefix. The tracker also serves other airlines that can reuse it once public samples exist.
- Events are staged by their status label, as [statuses.json](statuses.json) says. Places come
  from the bold airport names in each event's text, as "Dhaka (DAC)".
- Event times are the station's wall clock without a zone. The tracker orders events by sequence
  number, which the adapter follows.
- A booking only moves pieces onto a flight once the shipment is received: before the first
  departure it is accepted, after it in transit.
- A waybill delivered in parts is delivered once its delivered pieces reach its total, or a part
  says it is the total shipment. Until then the latest open stage leads.
- Weights, flights and their dates are not read.

## Limitations

- A refused reCAPTCHA token and an outage both answer with a bare server error page, so both are
  inconclusive.
- During the audio solver's pause only the checkbox is clicked. When it asks for a picture
  challenge instead, the lookup is never sent and the adapter reports a challenge.

## Numbers

A Biman air waybill is its prefix 997 and an eight-digit serial whose last digit is the first
seven modulo 7; the serial alone is accepted too. Detection has no rule, since every airline's
waybills share the format. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/biman-bangladesh/adapter.live.test.ts
```

The live test tracks the public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `BIMAN_BANGLADESH_TRACKING_NUMBER` tracks another waybill, and
`BIMAN_BANGLADESH_UNKNOWN_NUMBER` checks the not-found answer.
