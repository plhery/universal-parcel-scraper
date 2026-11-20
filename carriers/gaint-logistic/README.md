# Gaint Logistic

Gaint Logistic is a logistics platform in Noida, India. Merchants book courier, cargo and
e-commerce shipments on it, carried by its own fleet or by partner couriers, and its tracker
relays their scans. Tracked through the lookup its tracking page makes, past the page's security
code.

## How it works

1. `direct`: `GET https://gaintlogistic.com/api/captcha` for a security code, then
   `POST https://gaintlogistic.com/api/track` with the number, the code's token and its answer.
   It needs no cookie, account or browser. The reply gives the order's AWB and LR numbers, its
   status with whether it is delivered or returning, the courier that carries it, and its scans.
2. `retry`: one more read when the first fails to reach Gaint or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- The code is an SVG picture whose characters are text elements; read by their place from left
  to right, they give the answer. A code that does not match gets one more, as the page shows a
  new one, and a second mismatch is a challenge. A picture of another kind is a challenge too.
- The order must carry the whole number asked, as its AWB or its LR.
- A number without a shipment is HTTP 404 with "We have no shipment under that number", read as
  not found; any other refusal is inconclusive.
- A 403 or a browser check is a challenge, a 429 a rate limit, and a redirect a moved route.

## Notes

- Scans are instants. The page lists them oldest first; the adapter puts the newest first.
- The order's flags lead its stage: returning (`isRto`) is a return, then delivered. Otherwise
  its status leads, staged by Gaint's map or the shared rules, then the newest staged scan.
- Gaint's map knows `Booking Received` and reads any `RTO` wording as a return, as Indian couriers
  word one. A partner's relayed wording falls to the shared rules.
- The courier's name, such as Gaint's own `Gaint 10Kg Courier`, becomes `service_name`. The
  reply also gives the customer's city and the platform's order id; neither is kept.

## Limitations

- No estimate, weight or proof of delivery, and no provider code.
- A partner's shipment keeps the scans Gaint relays; the adapter names no partner.
- The page reads no number from its address, so there is no tracking link.
- A number reaches the adapter when it is filed under Gaint: no rule claims its numbers, so
  preflight does not ask it.

## Numbers

Gaint's own orders have an LR of nine digits and an AWB of `GNTB2B` and six digits; the tracker
also takes a partner's waybill. Detection has no rule for them. The adapter sends six to thirty
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/gaint-logistic`, with `GAINT_LOGISTIC_TRACKING_NUMBER`
and optionally `GAINT_LOGISTIC_UNKNOWN_NUMBER` set outside the repository.
