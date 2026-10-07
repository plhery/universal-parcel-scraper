# DPD Germany

DPD parcels tracked through the German business unit. DPD Switzerland remains
[dpd](../dpd/README.md), and DPD France is [dpd-fr](../dpd-fr/README.md).

## How it works

1. `direct`: the myDPD guest API, using `businessUnit=DPD-DE`. It shares the
   installation, Remote Config and OAuth protocol with the Swiss adapter.
   Tokens are cached per instance; all requests share the caller's deadline
   and cancellation signal.
2. `app`: the SOAP service of the German
   [DPD app](https://play.google.com/store/apps/details?id=de.dpd.mobile) at
   `https://api.paketnavigator.de/services/v1/Navigator3Service.asmx`
   ([service schema](https://api.paketnavigator.de/services/v1/Navigator3Service.asmx?WSDL)),
   over plain HTTP. It runs when the guest API fails, changes shape or has no
   history yet.

## Notes

- Both the requested number and returned parcel identity must match.
  Empty history is inconclusive; malformed or undated events are schema errors.
- A delivery postcode is optional. A rejected postcode gets one unverified
  lookup. Unverified replies omit places and the delivery window.
- The group API knows parcels across countries. A matching number does not
  prove a German destination, so this adapter is not a recognition candidate.
  An explicit current country outside Germany is inconclusive for this service,
  and the app service is not asked about that parcel.
- Scan offsets take precedence over local clocks. Germany and Switzerland
  share the same civil-clock rules for the supported tracking history.
- The Swiss page fallback is not used for German lookups.

## App service

`getSessionFullState` opens an anonymous device session, `getTrackingData`
binds the whole parcel number and gives the progress rail, and
`getTrackingScanList` supplies the scans. Each call carries the app's partner
name and token with a `KeyPhase` derived from its partner password, the
operation and the minute of the UTC day. These credentials are compiled into the
app, the same for every install and independent of any account, and are
included in the adapter. The app also sends a Firebase App Check token, which
the service does not require.

- The service takes tens of seconds to open a session and then accepts it for
  hours. One session is kept per adapter instance and replaced when the service
  rejects it. A lookup that has to open the session needs a budget above that
  delay.
- No postcode is sent, and `UpdateNewDeliveryData` and
  `addParcelIfNoTrackingdataAvailable` stay false, so a lookup changes nothing
  in the session.
- Scans carry English wording without codes. Each known wording is mapped
  whole, because the shared classifier misreads several of them. An announced
  delivery day is not a scan.
- Scan clocks have minutes and no offset. A scan at a German facility is read
  in German civil time, which agrees with the guest API's offsets for the same
  scans. A clock elsewhere stays local.
- The scans name their facility's town and country without a postcode, and
  include order registration before the first guest API event.
- The service reports "no tracking data" for parcels its scan list still
  knows, so that answer is inconclusive. A delivery address outside Germany is
  inconclusive too.

## Limitations

Recipient details, addresses, delivery proofs and preference links are discarded.
No UK service is inferred from a German result. The app service's reason codes,
parcel shop names and delivery estimates are not projected.

## Testing

`npm run test:carriers:live -- carriers/dpd-de`. Set
`DPD_DE_TRACKING_NUMBER` outside the repository for a positive lookup through
each tier.
