# DPD

DPD Switzerland (myDPD), Swiss last-mile parcels only. Germany is
[dpd-de](../dpd-de/README.md), France is [dpd-fr](../dpd-fr/README.md), and the
United Kingdom is [dpd-uk](../dpd-uk/README.md).

## How it works

1. `direct`: the myDPD Android app's guest API. A Firebase installation and
   Remote Config supply the public app credential, which obtains an OAuth token
   for the parcel-details call. Tokens are cached per instance. Concurrent
   lookups share a refresh; cancellation does not poison later lookups.
2. `page`: the rendered Swiss consignee page recovers from inconclusive guest
   replies, transport failures or mismatched identities. Cloudflare challenges
   require the browser service configured by `FLARESOLVERR_URL`.

A parcel-details 404 establishes absence. A 404 in the login chain does not.
Persistent service-unavailable replies end the lookup; other guest failures
can enter the page tier. Both tiers share the caller's deadline and signal.

## Notes

- Labels print a check character after the fourteen digits. A number typed with
  it is looked up by its digits; a character that does not match is refused as
  a typo. The German and UK adapters do the same, and detection offers the DPD
  networks for that form only when the character matches. The fourteen digits
  carry no check of their own.
- A delivery postcode is optional and sent only to DPD. It unlocks verified
  scans, places and the delivery window. A rejected postcode is retried once
  without verification, with `dpd_postcode_verified: false`.
- The postcode is the recipient's, in any country's format. The guest service
  also answers for parcels DPD delivers outside Switzerland, and a parcel filed
  under this carrier can be one of them, so the input is not held to four
  digits. DPD answers a postcode of the wrong shape like a wrong postcode.
- Automatic recognition requires the requested identity, dated activity and
  an explicit Swiss current country. Another country returns false; missing
  country evidence is inconclusive. A scan country is not a verified
  destination. Recipient fields and the issuing business unit cannot replace
  country evidence.
- Verified scans use the offset of their matching history entry where the
  pairing is unambiguous. Otherwise their local clock uses `Europe/Zurich`.
  This preserves repeated autumn-hour instants instead of choosing an offset
  from an unrelated scan.
- Scan codes take precedence over history enumerations. Unknown wording stays
  visible without an invented milestone. Scans are sorted newest first.
- A scan code is mapped where a live lookup paired it with a history
  enumeration, or where DPD's label names one movement: `HUI`, `HUS`, `DLS` and
  `DLQ` are hub and delivery-depot scans. `ORI` and `SPL` read like
  `IN_TRANSIT` and appear on both sides of the origin depot, so they stay
  unmapped. `statusMap` in [status.ts](status.ts) lists every code and label
  left unmapped on purpose, for the app's review queue, such as `ENA`, a data
  exchange inside DPD's systems seen before the parcel reached the origin depot.
- A proof-of-delivery bookkeeping entry is omitted when the actual delivery
  scan exists, so it cannot shift the delivery time. Delivery estimates are
  omitted after completion or an exception.
- Verified scans include notices that state the delivery day, and DPD's email
  notice adds a window. The newest notice supplies a missing estimate or the
  window for the reply's own day; a different day in the reply wins. An
  unreadable newest notice leaves no estimate, and a notice lapses at a pickup
  point or once a later scan passes its day. Notices remain events.
- While the parcel waits at a Pickup shop, the pickup point is the shop's
  name, then its street and its town on their own lines. Verified scans carry
  the shop's PUDO id: the newest scan with one names the shop, unless a depot
  scan came after it, as after the sender's drop-off at a shop. The German DPD
  app's `getParcelShopByID` ([shared service](../dpd-de/service.ts)) answers
  for Swiss shops too, and its record must name the same id. It gives the
  street and town in capitals. The reply's own shop name wins over the
  record's.
- That service opens an anonymous session once per adapter instance, which
  takes tens of seconds. A lookup waits for it within its budget, keeping five
  seconds to answer without the address, and the opening continues for the
  next lookup. Without the record the pickup point keeps the reply's name, or
  stays empty.
- `receiverName` and the `receiver` object are never read as the pickup
  point: they can name the recipient.
- Public, app-restricted Firebase identifiers are part of the anonymous app
  protocol. `DPD_FIREBASE_API_KEY` can override the key in the adapter
  environment.

## Limitations

The group-wide API's identity echo alone does not establish Swiss activity.
Recognition uses only the guest tier; an outage remains a failure instead of
classifying the number as unknown. Without a postcode, places, verified scans
and the pickup shop's address are unavailable. Recipient details, addresses,
delivery-proof URLs and preference links are discarded.

The guest API has no shop lookup by PUDO id. DPD Switzerland's website lists
shops near a coordinate, with ids and addresses, from
`www.dpd.com/ch/en/online-shipping/resources/get-pudo-points` without a key;
it cannot search by id.

The [Dutch myDPD page](https://www.dpd.com/nl/nl/ontvangen/) links to the same
Geopost Android package, `com.dpdgroup.chatbot.lemny.prod`. Its country selector
does not establish a separate Dutch API or authorize treating Dutch parcels as
Swiss. The German national app has a separate
[SOAP service](../dpd-de/README.md#app-service), which this adapter asks only
for Pickup shops.

## Testing

`npm run test:carriers:live -- carriers/dpd` checks the anonymous negative path.
Fixtures are synthetic and cover both response shapes
([fixtures/README.md](fixtures/README.md)).
