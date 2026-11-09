# NCS Kurir

NCS Kurir parcels use enabled universal providers. There is no dedicated adapter.
The public tracker refuses corporate AWBs, so some business deliveries can only
be followed through the sender.

The [guest page](https://ncskurir.com/ncskurir/track) fills its field from the `awb`
query parameter and opens a reCAPTCHA checkbox before requesting
`ncskurir/home/ajaxTracking?awb=...`. The callback sends no verification token to
that tracking endpoint. Its generic missing response carries no returned identity
and does not establish a working positive retrieval path.

The official [My NCS Android app](https://play.google.com/store/apps/details?id=com.visionaryteam.myncs)
uses `POST ncskurir/api/trace` with JSON `{awb}` and an application-wide `Auth`
header. This is a separate endpoint lead; a dated whole-number history is required
before it can support an adapter. Customer account and courier operations are
outside guest tracking.

Public sample evidence and its attribution are in `numbers.json`. There is no
number rule because the observed formats overlap other carriers.

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
