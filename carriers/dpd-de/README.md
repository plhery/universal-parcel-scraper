# DPD Germany

DPD parcels tracked through the German business unit. DPD Switzerland remains
[dpd](../dpd/README.md), and DPD France is [dpd-fr](../dpd-fr/README.md).

## How it works

1. `app`: the SOAP service of the German
   [DPD app](https://play.google.com/store/apps/details?id=de.dpd.mobile) at
   `https://api.paketnavigator.de/services/v1/Navigator3Service.asmx`
   ([service schema](https://api.paketnavigator.de/services/v1/Navigator3Service.asmx?WSDL)),
   over plain HTTP. Without a postcode it runs first, because its scans name
   their facility and include order registration, where the unverified guest
   reply has neither.
2. `direct`: the myDPD guest API, using `businessUnit=DPD-DE`. It shares the
   installation, Remote Config and OAuth protocol with the Swiss adapter.
   Tokens are cached per instance; all requests share the caller's deadline
   and cancellation signal. With a postcode it runs first, because DPD then
   verifies the reply and adds places and the delivery window; the app service
   follows it, with the same postcode.

Either service answers when the other fails, except for a parcel the guest API
does not know (a 404, or a 400 typed `PARCEL_NOT_FOUND` without a postcode, as
for [Switzerland](../dpd/README.md)) or a delivery placed in another country.

## Notes

- Both the requested number and returned parcel identity must match.
  Empty history is inconclusive; malformed or undated events are schema errors.
- A delivery postcode is optional. Both services check it against the
  recipient's. A rejected postcode gets one unverified lookup, and
  `dpd_postcode_verified` says which. Unverified guest replies omit places and
  the delivery window.
- The group API knows parcels across countries. A matching number does not
  prove a German parcel: a current country outside Germany is inconclusive for
  this service, and the other service is not asked about that parcel.
- Recognition asks the guest API without a postcode, as DPD Switzerland does,
  and knows a number only when the parcel's current country is Germany. Another
  country is unknown, and a reply without a country is inconclusive. The app
  service is not asked: a cold session takes tens of seconds to open.
- Scan offsets take precedence over local clocks. Germany and Switzerland
  share the same civil-clock rules for the supported tracking history.
- The Swiss page fallback is not used for German lookups.

## App service

`getSessionFullState` opens an anonymous device session, `getTrackingData`
binds the whole parcel number and gives the progress rail,
`getTrackingScanList` supplies the scans, and `getParcelShopByID` gives the
address of the shop holding the parcel. Each call carries the app's partner
name and token with a `KeyPhase` derived from its partner password, the
operation and the minute of the UTC day. These credentials are compiled into the
app, the same for every install and independent of any account, and are
included in the adapter. The app also sends a Firebase App Check token, which
the service does not require. The client is in [service.ts](service.ts), shared
with [DPD Switzerland](../dpd/README.md), whose Pickup shops
`getParcelShopByID` also knows.

- The service takes tens of seconds to open a session, whatever the device
  data, language or user agent. Sending a session's token back to
  `getSessionFullState` takes as long and returns another token. The reply
  gives no expiry. The service accepts a session for at least eight hours, one
  left idle for four too. While slow, it can refuse a session that it accepts
  again later.
- One session serves the process for each transport and user agent, shared by
  DPD Germany and DPD Switzerland and by the adapters of every registry. It is
  replaced when the service refuses it. From eight hours old it keeps serving
  while a lookup opens the next one beside it.
- Lookups share the opening, which can take two minutes and runs while a
  lookup that asked for it is still running. Ahead of the guest API, a lookup
  waits for it while keeping 20 seconds for the guest API, and asks the guest
  API meanwhile. A parcel the guest API does not know, or places in another
  country, ends the wait at once. Otherwise the default budget leaves time to
  wait, so the first lookup of a process lasts as long as the opening, and the
  guest API's reply answers if the session does not open in time. A lookup
  with less budget goes on to the guest API at once, and the opening continues
  until that lookup's budget ends.
- A long-lived host calls `warmDpdSession()` from `universal-parcel-scraper/node`
  at start, with its adapter environment's `fetcher` and `userAgent` if it sets
  them. The session then opens in the background and stays open: openings run
  to their end without a lookup, the next one opens eight hours after the last,
  and a failed one is tried again a quarter of an hour later. The timers do
  not keep the process alive.
- The host can also pass a `DpdSessionStore` as `{ store }`, which loads and
  saves `DpdSession` records. At start, the newest saved session younger than
  eight hours is taken up again instead of opening one; lookups wait up to five
  seconds for the store. Every session lookups stop using, renewed or refused
  during a lookup, is then checked once an hour with a shop id no shop has: the
  service answers it without a shop, or refuses the session. A refusal counts
  once the next check repeats it, and is saved as `refusedAt`; each acceptance
  is saved as `checkedAt`. `refusedAt - openedAt` is how long the service
  accepted the session, and checks stop a week after it opened. Checks of
  several sessions are five seconds apart. A failing store leaves lookups as
  they are without one.
- `getTrackingData` and `getTrackingScanList` take the postcode as
  `DeliveryZipCode`. A matching one returns `DataViewStatus`
  `DeliveryZipCode_isValid`; a wrong one, or any postcode for an unknown parcel,
  returns `ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID` with the anonymous view.
  For a delivered parcel, the verified view adds only the recipient's name and
  driver tip details, which are not read.
- `UpdateNewDeliveryData` and `addParcelIfNoTrackingdataAvailable` stay false,
  so a lookup changes nothing in the session.
- The recipient address reads Germany for parcels delivered in other
  countries, with or without the postcode. The current country is the newest
  scan's, else the country of the last status's depot; an unknown depot has a
  three-letter placeholder.
- Scans carry English wording without codes. Each known wording is mapped
  whole in [status.ts](status.ts), because the shared classifier misreads
  several of them. A collection the sender booked is still registration; the
  recipient's collection from a Pickup station or shop is the delivery. Its
  `statusMap` answers for both services: the app's scans by wording, the guest
  API's by DPD's codes. A return names itself in its scans:
  it stays an exception under way and becomes returned at the sender, and the
  progress rail's return state keeps the result in the exception status. An
  announced delivery day is read as an estimate, without becoming a scan or
  changing tracking freshness.
- Estimates use the flagged live delivery window, a specified planned date,
  or a fully dated announcement. A changed planned date replaces the previous
  window, as in the app. Placeholder dates, incomplete windows and display
  dates without a year are ignored; completed delivery and pickup availability
  clear the forecast. Offset-bearing windows use German civil time; unresolved
  window clocks retain their supplied digits.
- Scan clocks have minutes and no offset. A scan at a German facility is read
  in German civil time, which agrees with the guest API's offsets for the same
  scans. A clock elsewhere stays local.
- The scans name their facility's town and country without a postcode, and
  include order registration before the first guest API event. A parcel shop
  or locker scan also names the shop and its PUDO id. While the parcel waits
  there, the shop becomes the pickup point: its name, then its street and its
  town on their own lines. The address comes from `getParcelShopByID` for that
  PUDO id and must name the same one. Without it the name stands alone. The
  shop's phone, opening hours and coordinates are not read. A delivered parcel
  has none, collected there or not.
- The order's measured length, width and height are in millimetres. A side of
  zero means no measurement, and the shipper's declared size is not read.
- The service reports "no tracking data" for parcels its scan list still
  knows, so that answer is inconclusive. A delivery address outside Germany is
  inconclusive too.

## Limitations

Recipient details and addresses, delivery proofs and preference links are discarded.
No UK service is inferred from a German result. The app service's reason codes
and driver details are not projected. The app service does not name the sender,
nor does the guest API's unverified reply. An estimate requires a forecast in
DPD's reply. A delivery postcode can unlock the guest API's window.

## Testing

`npm run test:carriers:live -- carriers/dpd-de`. Set
`DPD_DE_TRACKING_NUMBER` outside the repository for a positive lookup through
each tier and its recognition, and `DPD_DE_POSTCODE` to check the app's
postcode verification.
