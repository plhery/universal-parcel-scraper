# Rincos

Rincos cross-border parcels are read from its anonymous rendered tracker. Select Rincos
explicitly or use its tracking link; the shared numeric shape has no detection rule.

## How it works

1. `direct`: one GET of the [Rincos result page](https://www.rincos.asia/out/TraceInfo_kr.do)
   with `SCGBN=20` and the whole number in `P_VAL`. Its `frm` form and `goSearch` builder
   submit the same fields. No session, login or browser is needed.
2. `retry`: one further read after a network failure, inside the same lookup budget.

The printed Rincos shipment number must match the whole requested number. Both origin and
collapsed destination histories are retained, along with a recognized delivery partner and
its number. Recipient, sender, order, print and remark details are omitted.

Origin and destination rows keep their local wall clocks and the portal's order within each
leg. Korean origin clocks and destination facility clocks do not establish one shared zone;
the adapter adds no offset, and preserves an offset if the carrier supplies one.

## Limitations

The no-information notice does not distinguish an unknown number from expired history, so
it is inconclusive. Empty pages, changed layouts and blocked responses remain failures. A
current status without its corresponding milestone is marked as partial history.

## Testing

`npm run test:carriers:live -- carriers/rincos`, with `RINCOS_TRACKING_NUMBER` and optionally
`RINCOS_UNKNOWN_NUMBER` set outside the repository. These tests call Rincos directly.
