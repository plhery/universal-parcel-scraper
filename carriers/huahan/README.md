# HuaHan Logistics

Tracks HuaHan's own waybills through its public guest tracker. HuaHan carries parcels from
China to destination delivery partners.

## Retrieval

The [public form](https://www.hh-exp.cn/WebTrack/CargoTrack.html) opens verification through
`init.php` and asks `tncode.php` for its challenge. That is a picture whose characters are
clicked in order (`click_captcha`), or a plain arithmetic question. After `check.php` accepts
the clicks or the answer, the form posts one complete waybill to `CargoTrackActionPlus.php` in
the same cookie session. The lookup refuses an unverified session.

The direct step answers the arithmetic question itself. The picture needs OCR, so the
browser service's [helper](../../trawl/huahan-verify.mjs) runs the same requests and reads it
with the worker ZTO's helper uses, without opening a browser. It submits a reading only when
the worker is sure of it, tries at most three pictures, and returns the tracking reply without the
shipper's reference or names. HuaHan answers some addresses only with a gateway error;
`HUAHAN_BROWSER_PROXY_URL`, an HTTP(S) proxy origin, sends the helper's requests through that
proxy. While HuaHan shows the picture the direct step rests, as
each of its tries opens a session. HuaHan caps the verification sessions one address opens in
an hour; that refusal is a rate limit and ends the lookup.
Verification diagnostics distinguish missing reader points, the wrong point count, low confidence
and coordinates outside the picture without retaining the image, characters or click positions.

The reply must repeat the requested waybill and confirm success. An explicit absence is
not found; verification failures, changed replies and an empty history remain distinct.
The adapter keeps the server's scan order, milestone codes, wording and locations. The
history runs from the order data in China through export, the flight and import clearance
to the destination carrier's scans.

- `Country_code` is the destination country. `Local_Carrier` and `Local_Number` name the
  destination carrier and its number. A suffix after an underscore (`_D104`) is not part of
  that number. The carrier is named only when the catalog knows it and its rules fit the
  number. When they name no carrier, a transfer row (`转单:` and a number) names the carrier
  whose own rules claim that number whole at high confidence, such as UPS for a `1Z` number on
  the US line, with that number. The row moves nothing, so it keeps the stage of the scan
  before it. The shipper's reference is omitted.
- Clocks have no offsets. After `Has been given to local carrier` (`JY`) the reply relays the
  destination carrier's scans on that carrier's clock, cut to the minute: a French history
  matched its partner's own tracker in French time. A destination country of one zone
  places those scans. Landmark Global's page writes every clock in US Central time, and
  HuaHan relays it so: when the reply holds Landmark's own words (`Shipment Data Uploaded`,
  its depot's incoming and outgoing scans), the scans after the hand-off and Landmark's
  uncoded record of the sender's data and its processing are read on Chicago's clock. Read
  so, they fall at the instants bpost and Posta Romana give the same steps. Both name
  Landmark's office, not a place the parcel has been, so they keep no place, and the
  processing is a notice on the stage of the record before it. HuaHan's own scans,
  in China and at the destination airport, stay local times. CTT Express's notice of the parcel coming (`Pendiente de recepción en CTT
  Express`), relayed before the hand-off, is on CTT Express's own clock, Madrid's, on parcels
  bound for Portugal too: read so, it falls minutes after HuaHan's arrival scan in China, in
  winter too, and hours before it on China's clock or an hour after it on Lisbon's. The clock
  CNE and JS Express relay CTT Express's statuses on, two hours after its instant all year, would
  put it an hour before the arrival in winter. DHL Paket's rows relayed before the hand-off, which
  name no place, are on Germany's clock: on the Chinese warehouse's they came seven hours before
  DHL's own rows of the same steps.
- The reply can list a destination carrier's scan twice at the same minute: in that carrier's
  words at its place, and in HuaHan's generic words without one. The placed line stays, with
  the generic line's code when it came without one, so it keeps the code's stage.
- A missed delivery told again within 12 hours, with no new round between, is the partner's
  detail of the same attempt (where the parcel waits now): a notice, so the parcel shows one
  attempt.
- HuaHan's codes are two capitals. A tracking provider relays its scans in HuaHan's words
  under the provider's own codes, so the status map reads those scans by their words.
- An American partner's scans ("Picked up by Shipping Partner", its facility's arrival and
  departure) can come before the flight leaves China: written ahead, they read as transit, not
  as the parcel's acceptance.
- On the postal line the reply relays China Post's scans in Chinese, offices in 【】, and the
  destination post's as China Post copies them, some under `DR`, `IA` or `CA`. China Post's
  vocabulary reads them; its receipt after HuaHan's own acceptance is the hand-over, in transit.
  A destination post's posting record after the hand-off (`Posting/collection`), like any
  acceptance after `JY`, is in transit too, and its rounds that did not deliver come under `FI`, read by their words.
- USPS's facility scans come under `ND` and are read by their words. HuaHan also puts its
  out-for-delivery code `CB` on USPS's departure from a distribution centre, so under `CB`,
  `PB` and `CC` the words decide when the map knows them and the code otherwise. It puts `CB`
  on Landmark Global's depot departure too, days before bpost's delivery round. USPS's
  pre-advice and DHL's record of the sender's data, written while HuaHan still has the parcel,
  are registered.

## Numbers

HuaHan waybills are `HHW`, two letters, ten digits and `YQ`. Its API documentation describes
that layout, which detection and the adapter accept. Postal and partner references are
outside this adapter's scope.

## Limitations

There is no cheap recognition flow: tracking requires a fresh verification exchange. Without
the browser service, or when no picture passes, the picture remains a challenge and enabled
universal providers can recover. Provider history can supplement scans whose clocks cannot be
placed on a timeline.

The customer API at `api.hh-exp.com/default/svc/web-service` needs account credentials;
it is separate from the anonymous web form.

## Testing

Set `HUAHAN_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/huahan`. `HUAHAN_UNKNOWN_NUMBER` checks explicit absence.
