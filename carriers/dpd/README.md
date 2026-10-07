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
  networks for that form only when the character matches.
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
- A proof-of-delivery bookkeeping entry is omitted when the actual delivery
  scan exists, so it cannot shift the delivery time. Delivery estimates are
  omitted after completion or an exception.
- Public, app-restricted Firebase identifiers are part of the anonymous app
  protocol. `DPD_FIREBASE_API_KEY` can override the key in the adapter
  environment.

## Limitations

The group-wide API's identity echo alone does not establish Swiss activity.
Recognition uses only the guest tier; an outage remains a failure instead of
classifying the number as unknown. Without a postcode, places and verified
scans are unavailable. Recipient details, addresses, delivery-proof URLs and
preference links are discarded.

The [Dutch myDPD page](https://www.dpd.com/nl/nl/ontvangen/) links to the same
Geopost Android package, `com.dpdgroup.chatbot.lemny.prod`. Its country selector
does not establish a separate Dutch API or authorize treating Dutch parcels as
Swiss. The German national app has a separate
[SOAP flow](../dpd-de/README.md#mobile-api-alternative).

## Testing

`npm run test:carriers:live -- carriers/dpd` checks the anonymous negative path.
Fixtures are synthetic and cover both response shapes
([fixtures/README.md](fixtures/README.md)).
