# Aeropost

The native adapter reads Costa Rican shipper histories from the
[public tracking page](https://aeropost.com/en/tracking). Other Aeropost services,
courier identifiers and Temu order numbers use enabled universal providers.

TRAWL opens a fresh guest page and lets its own reCAPTCHA verification run. The
reply carries no shipment identifier, so capture requires the exact whole-number
shipper POST from that page's main frame. The browser helper retains only bounded
tracking fields; verification tokens, cookies and rendered recipient details stay
inside its context. Recognition stays disabled because the history states no instant.

The page's event codes distinguish a local-courier handoff from final delivery.
Scan clocks carry no offset and remain local wall times, including on histories
that cross countries. Processing placeholders are not shipment events.

[Aeropost's Android app](https://play.google.com/store/apps/details?id=com.aeropost.courierapp)
links its Temu tracking action to the public tracking portal. Its package-management
API uses customer account state and supplies no verified guest alternative.

Live checks use `FLARESOLVERR_URL`, `AEROPOST_TRACKING_NUMBER` and
`AEROPOST_UNKNOWN_NUMBER`:

```sh
npm run test:carriers:live -- carriers/aeropost/adapter.live.test.ts
```
