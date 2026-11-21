# NuMark Transportation

NuMark Transportation is an LTL and truckload carrier based in San Leandro, California, serving
California, Arizona, Nevada and Hawaii. Its PRO numbers are tracked through the PRO trace the
quick trace form on its site opens.

## How it works

1. `direct`: one `GET http://tracking.numarktransportation.net/cgibin/wbprotrk?wbfb={pro}&wbscac=&idbutton=Trace`,
   as the site's form sends it. It needs no cookie, key, CAPTCHA or browser. The host answers
   plain HTTP only. The page gives the PRO number, the parties and one row per status, oldest
   first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A PRO number without a bill is HTTP 200 with "Error: Bill not found" and the number back in the
  form. "Invalid Pro number" refuses the number's form: the trace takes five to nine characters,
  and the adapter sends only five to nine digits.
- The adapter keeps an answer only when its `Pro:` heading is the number asked.
- The trace is `wbprotrk`, the PRO trace of the TGIF freight system, which other LTL carriers
  run on their own hosts. [wbprotrk.ts](wbprotrk.ts) holds the request and the reader, so
  another carrier needs only its address, number rule and status map.

## Notes

- A row gives a day without a clock. A row with the driver's clock in and out, such as a
  delivery, is dated by the out clock, when the driver left with the receipt signed, else by the
  in clock. These stay wall clocks in `local_time`: the page names no zone, and the terminals are
  on Pacific and Arizona time.
- A row's place is its origin terminal, else its destination terminal: a transfer runs from the
  first to the second. A delivery names no terminal.
- The signature column gives a manifest number, or who signed for a delivery, so it is not kept.
  Of the parties only the consignee's town and state are kept, as `receiver_address`, without
  its name or postcode; the shipper, the debtor and the shipper and P.O. numbers stay behind.
- Wording the map does not know stays without a stage: the shared wording rules read "pick up"
  as a parcel waiting at a pickup point, which an LTL pickup is not.

## Limitations

- No estimate, weight, service or proof of delivery.
- The trace also takes a partner's PRO number with the partner's SCAC; the adapter sends only
  NuMark's own.
- Nine digits are shared by many carriers, so no rule claims them and preflight does not ask
  NuMark. A PRO number reaches the adapter when it is filed under NuMark or opened from a link to
  the trace.
- The catalog links no carrier page for a number, as the trace is plain HTTP; links to it are
  read.

## Testing

`npm run test:carriers:live -- carriers/numark-transportation` tracks the public sample in
[`numbers.json`](numbers.json), or the PRO number in `NUMARK_TRANSPORTATION_TRACKING_NUMBER`, and
an invented one, or `NUMARK_TRANSPORTATION_UNKNOWN_NUMBER`.
