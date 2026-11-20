# Swiss Post

Swiss Post domestic parcels and inbound international letter-post (`…CH` S10
numbers), tracked through the anonymous API of «My consignments», Swiss Post's
public tracker on `mys.post.ch`. A postal item from abroad is handed off here under
its own S10 number when its carrier reports Switzerland as the destination, as
is AliExpress/Cainiao letter-post with a Swiss-issued `L…CH` number
([handoff.ts](../../core/catalog/handoff.ts)). Freight goes to
[swiss-post-cargo](../swiss-post-cargo/README.md) and PostLogistics
track-and-trace to [postlogistics](../postlogistics/README.md).

## How it works

`direct`: two calls under
`https://mys.post.ch/mailpiece-tracking-api/logistics/mailpiece/tracking/v2/mailpieces/compact/`,
with no session, cookie or token, each bounded at 10 s and sent once more if it
fails to reach Swiss Post or hangs: until then a call gets at most half of the
time left, so the retry fits in the rest.

1. `GET ?mailpieceId={number}&includeAvailableServices=false` searches the number
   and returns `mailpieces`, each item's summary with its `mailpieceKey`. The
   trailing slash before the query and `Accept-Language` are required. An empty
   list is the clean not-found; HTTP 404 means the API moved, a transport failure.
2. `GET {mailpieceKey}/detail` returns the item with its scans (`events`).
   Optional: if it fails (HTTP 404 for a key it does not know), the search's
   summary is still returned, marked `summary_only`.

`Accept-Language` sets the wording of the scans and the summary. The tracker has
English, German, French and Italian, and the lookup's `language` picks one; any
other language gets English (the tracker itself answers it with German). Stages
come from codes, and a revoked scan is recognised by its label in all four. The
identity policy in [app.ts](app.ts) lets a scan reworded in another language take
over its stored row by provider code, instant and location, unless one of the two
is revoked.

## Notes

- The portal link is the address Swiss Post's own tracking form opens,
  `www.post.ch/swisspost-tracking?formattedParcelCodes=…`, which forwards to the
  parcel's page in «My consignments». Pasted links of that kind, of
  `mys.post.ch/my-consignments/deeplink-search`, and of the former tracker's
  `service.post.ch/ekp-web` pages name Swiss Post.
- 18-digit `98`/`99` parcel numbers carry no check digit (identifier, franking
  licence and counter), so detection cannot reject a mistyped one.
- During an outage any call can answer, even with HTTP 200, with Swiss Post's
  outage page, which only refreshes to `sorry.post.ch`. That answer is
  inconclusive, not a malformed reply or a missing parcel, and the call is not
  repeated.
- During planned maintenance the API redirects to `www.post.ch`'s maintenance
  page, which is read as maintenance. Any other redirect is a transport failure.
  Neither is repeated.
- Exactly one item must match the number, on `mailpieceId` or the
  `internationalMailpieceId` it was given abroad — the endpoint is a search. None
  or two matches are refused, and so is a detail naming another item. Numbers
  are compared without spaces, dots or dashes, so the portal's dotted form matches.
- Each scan's `provider_code` is written as the former tracker wrote it, and as
  stored scans carry it: the item's `type`, a star, its product code and the
  scan's own code (`PARCEL.*.2.1202`).
- The newest event code overrides the summary's `status.status`, which lags: a
  MyPost24 locker deposit (`2102`) reads `DELIVERED` while the parcel still
  waits for pickup. When the newest scan has no stage (an enquiry or delay
  note, a recipient's order, an import process abroad cancelled with no
  outcome stated, an unmapped code, no scans yet), the summary gives it. `statusMap` in [status.ts](status.ts) lists the notes and orders
  left without a stage on purpose. A pickup point may scan its own arrival
  (`1001`, `1100`) after the ready-for-pickup scan (`2101`, `2102`), and a post
  office its arrival after the pickup notice the round left (`910`, `2100`); the
  item then stays ready for pickup.
- Codes are classified, not wording. One table serves letters and parcels.
  Several English wordings mislead: "Completion of customs clearance" and
  "Arrival at the collection/delivery point" are neither active customs nor a
  delivery, and `910` and `2100` "Registered for collection" are pickup notices.
  Unmapped codes get no stage and are left to the sync.
- A scan's wording is its `title`, followed by the detail the tracker shows under
  it (`additionalInformation.information`) when that differs, as "Delivered —
  Deposited with authorization for delivery". A scan without wording gets a
  built-in label, else its code. A revoked scan's wording ends with "Revocation"
  in the reader's language; it takes no stage.
- A shipment sent back reads "Delivered" once it reaches its sender again; the
  status `RETURNED` or the item's "Return item" badge, in any of the four
  languages, turns that into returned.
- An anonymous lookup gets no pickup point: the tracker shows the office or
  terminal holding a parcel only to its signed-in recipient.
- Weight (sent in grams), measurements (millimetres; most letters have two) and
  delivery time come from the item. The estimate is `status.expectedDelivery`
  read as the tracker's page shows it: its day with the time slot its bounds
  name, or the days of a window that spans several (`expected_delivery_from` to
  `expected_delivery`). It is dropped once the shipment is delivered or returned.
- The reply names no destination country. An item sent abroad (`international`
  `EXPORT`) takes it from the country domain of the destination post's tracker
  that Swiss Post links (`exportTrackingUrl`), or as the United States for USPS;
  an item at home takes Switzerland or Liechtenstein from the delivery postcode.
- Timestamps are kept as sent, with the seconds the tracker leaves out when they
  are zero written back, and parsed only to sort (offset-less values read as UTC
  for that comparison), but for the destination post's events and those of the
  origin offices and the pre-advice [clock.ts](clock.ts) lists. The whole history
  is sorted before the newest 100 scans are kept, so the newest scan sets the
  stage whichever way the reply lists them, and `history_truncated` marks a
  history with older scans left out.
- On a parcel Swiss Post sends abroad, the destination post's events (codes 901,
  902, 909, 918–921, 923, 924, 926, 934, 938) come with no city, postcode or
  country, and carry that office's wall clock under Swiss Post's offset: an El
  Salvador delivery round at 12:26 local came as `12:26+02:00`. UPU's record has
  the same 12:26 at El Salvador's office, and Correos de El Salvador's own tracker
  dates it 18:26:18 UTC. On an item to China, customs (901, 902) came at the 11:05
  and 14:30 UPU gives Beijing's and Hangzhou's offices. They are read on the clock
  of the destination country when it keeps one. In a country with several, they
  keep Swiss Post's offset, the last guess: hours off, but the reply keeps its
  instants. The app identity policy in [app.ts](app.ts) (`relabelledFrom:
  'Europe/Zurich'`) lets a scan read on the destination's clock take over the row
  stored under Swiss Post's offset, by wall clock, provider code and location.
  Swiss Post's own unlocated events (813, 915) keep its offset. [clock.ts](clock.ts)
  lists them, and their wording for relays that give no code.
- On a parcel from abroad (`international` `IMPORT`), the origin post's events
  (`912`, `913`, `915`) carry its office's wall clock under Swiss Post's offset
  too: a departure from a London office of exchange came at the 17:57 UPU gives
  that office, as `17:57+02:00`. The reply names no origin to read them in, and
  the barcode's post can run an office in another country. So an office is
  placed by its name: those [clock.ts](clock.ts) lists (London's, "LON" and a
  letter) are read on their own clock, and the stored rows move over by the
  identity policy above. The others keep Swiss Post's offset, right for a
  neighbour on its clock and an hour or more off elsewhere.
- A letter's pre-advice (`859`, "will shortly be handed over") is the notice of a
  Chinese consolidator posting letters in Switzerland through its European hub,
  on its system's Beijing wall clock under Swiss Post's offset: one came at
  `18:12+01:00` in a reply given at 13:58 Swiss time. It is read on Beijing's
  clock whoever the reply names as sender. Read so, it can follow the posting it
  announces; it then moves nothing and keeps the stage of the scan before it.
  Senders in Switzerland, for letters and parcels alike, give their pre-advice as
  `600`, which keeps Swiss Post's offset.
- Wording is only trimmed, not whitespace-collapsed, so `core/transport`'s
  `clean()` is not used.
- A scan's location is the facility's name and postcode ("Härkingen
  Paketzentrum 4622"). The former tracker ended the name with Swiss Post's
  six-digit site number instead ("Zürich Briefzentrum 801050"), which relays
  still carry and the map places known sites by ([places](../../places/README.md)).
  The identity policy in [app.ts](app.ts) lets a scan naming its facility by
  postcode take over the row stored with the site number, in the same code and
  at the same instant. A scan without a city keeps its explicit country; the
  carrier's home country is never substituted. A scan with neither has no
  location, even when it carries a postcode. The reply can list one scan twice
  at one instant, with and without its place; the copy without a place is dropped.
- An anonymous lookup gets only the postcode and town of the delivery address,
  kept as `receiver_address`. The sender's address, documents, signature and
  delivery instructions are not read.

## Testing

`npm run test:carriers:live -- carriers/swiss-post` (no env
vars; checks that an S10 number with a wrong check digit returns a clean 404). The
fixture is a synthetic item detail in the shape the tracker sends.
