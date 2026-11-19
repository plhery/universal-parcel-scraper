# BH Pošta

BH Pošta, JP BH POŠTA d.o.o. Sarajevo, tracks its postal items and mail it receives from other networks through the guest form embedded on its [tracking page](https://www.posta.ba/pracenje-posiljaka/).

## Retrieval

The adapter opens the ASP.NET form at bhpwebout.posta.ba and posts fresh view state with the whole S10 item code in the same anonymous cookie jar. Both the returned input and event-table heading must name the requested item. Scan clocks remain local without an invented offset. The free-text notes column is not read.

An empty event table carries no explicit missing verdict, so it stays inconclusive and enabled universal providers can continue. Verification pages, rate limits, changed tables and transport failures retain their error kinds.

## Numbers

The three postal operators in Bosnia and Herzegovina share the S10 suffix `BA`; it does not identify BH Pošta. Generic postal detection remains in place. The adapter confirms service ownership through actual history rather than a new number rule.

## Testing

```sh
BH_POSTA_TRACKING_NUMBER=<public-or-private-input> npm run test:carriers:live -- carriers/bh-posta/adapter.live.test.ts
```
