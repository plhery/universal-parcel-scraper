# BH Pošta

BH Pošta, JP BH POŠTA d.o.o. Sarajevo, tracks its postal items and mail it receives from other networks through the guest form embedded on its [tracking page](https://www.posta.ba/pracenje-posiljaka/).

## Retrieval

The adapter opens the ASP.NET form at bhpwebout.posta.ba and posts fresh view state with the whole S10 item code in the same anonymous cookie jar. Both the returned input and event-table heading must name the requested item. Scan clocks remain local without an invented offset. The free-text notes column is not read.

An empty event table carries no explicit missing verdict, so it stays inconclusive and enabled universal providers can continue. Verification pages, rate limits, changed tables and transport failures retain their error kinds.

## Numbers

The three postal operators in Bosnia and Herzegovina share the S10 suffix `BA`, so it does not identify BH Pošta and detection keeps its generic postal answer. A low S10 rule lets recognition ask BH Pošta about these items; its history confirms the item.

## Testing

```sh
BH_POSTA_TRACKING_NUMBER=<public-or-private-input> npm run test:carriers:live -- carriers/bh-posta/adapter.live.test.ts
```
