# AKS Express Kurir

AKS Express Kurir parcels use enabled universal providers. There is no dedicated adapter.

## Retrieval

The [aks.rs guest form](https://www.aks.rs/pracenje-posiljke/) posts `shipping_id`
and a reCAPTCHA v2 response. The carrier's [terms](https://www.aks.rs/opsti-uslovi/)
also identify `akskurir.com` as an official tracking portal.

That portal's [guest page](https://www.akskurir.com/Tracking/Index) shows a
BotDetect image challenge, while its request builder posts the whole number as
a JSON string to `/Tracking/GetTrackData`. The endpoint can answer without a
verification token. Its `Res=101` selects the page's missing-shipment notice;
successful replies use `lstData`, rendered as status, location and clock.
No usable public reference establishes a dated positive and returned identity
through this route.

The [official Android announcement](https://www.aks.rs/vesti/android-aplikacja/)
links package `io.blq.AKSExpress`. Its historical Cordova bundle calls
`/BLQPostalSmartPhoneApp/BLQSmart/GetStatusProm` with a JSON array of barcode
references. The request builder supplies no account header, but empty arrays
alone do not establish a usable guest-history contract. The store listing is
unavailable; an authoritative signer binding for the archived APK is unproved.

The older `AKSVipService/Pracenje` route has uncertain matching behavior and is
not a safe source without independently verified whole-response identity.
VIP Gold account operations remain separate from guest tracking.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
