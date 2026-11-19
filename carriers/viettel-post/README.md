# Viettel Post

Reads current guest history in a fresh TRAWL browser, with the legacy text-CAPTCHA shipment
record as fallback. No account, recipient phone or delivery credential is used.

## Retrieval

The [public guest form](https://viettelpost.vn/viettelpost-iframe/tra-cuu-hanh-trinh-don-hang-v3-recaptcha)
posts one whole waybill to `api/orders/viewTrackingOrders3` after reCAPTCHA verification.
Its client creates a fresh browser key and signs the guest request with an ES256 `X-Token`
proof. The browser executes that client; keys and verification tokens remain in its context.
`VIETTEL_POST_BROWSER_PROXY_URL` routes the whole context through the caller's configured
proxy, including verification and tracking. It never falls back to another address.

The capture starts before navigation and retains bounded verification refusals and retries.
The shipment and every scan must repeat the whole waybill. Hidden query echoes and empty
histories remain inconclusive. Contacts, addresses, recipient prose and delivery controls
are excluded. The milestone groups are ordered by each scan's local wall clock; no offset
or delivery estimate is invented. Administrative edits retain the preceding stage.

The full-history attempt reserves time for the legacy record. When TRAWL is unavailable or
verification cannot finish, a fresh cookie jar uses `getCaptcha` and `viewTrackingOrders`.
The bundled local OCR model reads the text code, with one refresh after unreadable or refused
text. This record can remain at registration after delivery, so it is marked `summary_only`
and enabled universal providers are asked for richer history. An unavailable legacy endpoint
is a transport failure.

## Limitations

Neither HTTP nor browser recognition opens this verification flow. Shared numeric layouts
do not establish carrier ownership. Existing order-page links can be read, but the signed-in
page is not built as a public tracking address. The Android app's separate guest history
endpoint is not used.

## Testing

Set `VIETTEL_POST_TRACKING_NUMBER` and optionally `VIETTEL_POST_UNKNOWN_NUMBER` outside Git.
Configure `FLARESOLVERR_URL` and the browser proxy to exercise current history, then run:

```sh
npm run test:carriers:live -- carriers/viettel-post
```
