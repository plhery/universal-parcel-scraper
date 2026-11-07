# Qatar Post

The dedicated adapter reads the public guest route shipped in the
[official Android app](https://play.google.com/store/apps/details?id=qa.com.qatarpost2).
It accepts checksum-valid postal S10 identifiers, including another post's identifier for mail
handled in Qatar. It also reads Qatar-issued S10 histories, including foreign postal events
relayed by the guest API. Domestic shipment histories are unconfirmed.

Each GET to `web.qatarpost.qa/QPAPPDBN/api/CustomerOrdersDetails/track-order-details/{number}`
sends `Platform: Mobile` and a fresh `Guest-API-Token`. The app creates that header by encrypting
its UTC clock and shared guest configuration with AES-256-CBC. These public app constants need
no consumer credentials. No login, device registration, recipient phone or OTP is used. The
app's advanced verification routes are separate and unused.

Both root identifiers and one unique nested shipment must match the whole request. The adapter
keeps all returned scans, including rows marked invisible to a digital channel, as the app's
mapping does. It drops contact, address, payment and proof fields. Scan clocks stay local: the
reply relays overseas facilities too. `expected_time` repeats the scan clock and is not used as
an estimate. A stated larger history count or a newer summary keeps the answer incomplete, so
enabled providers can fill it. Recognized physical scan codes can stage a shipment whose
workflow summary is unclassified; record-entry actions alone do not establish movement.

Qatar is a destination-post lookup candidate for S10 mail. This does not change issuer
detection or claim every foreign postal item. There is no broad recognition rule; a provider
hint alone does not schedule a direct preflight query. The retained public sample proves
retrieval, and is too old to prove recent recognition settlement.

The website link stays on the public TrackAndTrace page. That page uses reCAPTCHA v3 and can
refuse a fresh token; the native adapter uses the separate mobile guest route.

```sh
QATAR_POST_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/qatar-post
```
