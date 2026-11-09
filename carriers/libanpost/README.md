# LibanPost

The dedicated adapter reads the official mobile guest tracker over HTTP. International mail
and domestic references share that form. The adapter accepts a reference only when the
returned shipment number matches it in full and the summary names a Lebanese postal leg.

## Retrieval

`TrackandTraceMobile.aspx?sn={number}&lang=2` returns a shipment summary and the full scan list
without a cookie, account or CAPTCHA. The Android package's tracking screen opens that page
in a WebView; its separate `Api/App.svc` account operations are not needed. The adapter reads
the service, destination and scans, leaving signature names and the summary's sending date
out. Facility clocks have no stated zone and remain local wall times, including foreign scans.

The ordinary English and Arabic tracker pages require a solved Google reCAPTCHA form
postback. They are not used for retrieval. The historical Android package is available from
[APKPure](https://apkpure.net/libanpost/com.libanpost); its former Google Play listing is
unavailable. The mobile page itself remains on LibanPost's official domain.

## Numbers

Postal detection handles S10 numbers. Public domestic `PX` evidence does not establish its
format or a confirmed history, so no detection rule claims it. Select LibanPost explicitly to
use its dedicated tracker; enabled universal providers can supply histories it does not hold.

## Testing

`LIBANPOST_TRACKING_NUMBER` and `LIBANPOST_UNKNOWN_NUMBER` supply private live controls:

```sh
npm run test:carriers:live -- carriers/libanpost/adapter.live.test.ts
```
