# UMAC Forwarders Express

Select UMAC Forwarders Express and enter the box number. The carrier embeds a public tracker on its website. The adapter calls the guest lookup on that tracker and checks the exact returned box number. [Official tracker](https://www.umaccargo.net/track-your-box-new.html)

The adapter uses recognized actual movements and keeps their calendar dates. It omits estimates, contact details, addresses and delivery recipient information. The carrier’s current milestone resolves same-day ties when it also appears in the result.

```sh
UMAC_TRACKING_NUMBER=UMTC461625 UMAC_MISSING_NUMBER=UMTC350514 npm run test:carriers:live -- carriers/umac-cargo
UMAC_TRACKING_NUMBER=UMTC458065 npm run test:carriers:live -- carriers/umac-cargo
```
