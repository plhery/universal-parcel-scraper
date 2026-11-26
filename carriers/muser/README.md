# Muser International Logistics

Muser (Shenzhen Muser International Logistics) is a Shenzhen cross-border forwarder.
[17TRACK](https://www.17track.net/en/carriers/muser) and
[ParcelsApp](https://parcelsapp.com/en/carriers/muser-cn) list it, with www.muserxm.com as its site.
The adapter reads its tracker's own lookup for numbers of MS, fourteen digits and YD.

## How it works

1. `direct`: ParcelsApp hands Muser parcels to `http://msgyl.rtb56.com/track_query.aspx`, a tenant
   of the rtb56 platform, which answers the platform's `GET /webservice/Service.ashx` lookup
   without a cookie, account or CAPTCHA. The adapter sends the same request as
   [YYpost's](../yypost/README.md), through the module the platform's adapters share. The host
   answers plain HTTP only.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

- Only the entry whose `server_hawbcode` is the whole number asked is read.
- The tracker's unknown-number answer is a not-found. Its "Parameter error" is a schema failure
  and any other refusal is inconclusive. Redirects, 404s and browser checks are never read as a
  missing parcel.
- Recognition makes the same lookup.

## Notes

- Every scan states China's offset, the delivering network's in the United States too, whose
  clocks read as their town's: a delivery round would otherwise go out late at night. So every
  scan keeps its wall clock, and a consumer dates it by its place.
- The delivering network's scans leave the place empty and follow the wording with the town and
  ZIP Code, past a run of spaces: two before a town and ZIP Code, three or more otherwise. The town becomes the place, with the state the ZIP Code is in
  for a parcel to the United States; the ZIP Code itself is not kept.
- Scans are English wording with the tracker's own codes, which the delivering network's scans
  lack, so the stage comes from the wording: [statuses.json](statuses.json), then the shared rules.
- The merchant's order reference, the proof-of-delivery link and the signatory are not read.
- The site its listings give no longer serves the company: over HTTPS its certificate names another
  host, and over HTTP it sends the visitor to an unrelated sign-in page.
  [Zhongzhou Logistics'](../zhongzhou-logistics/README.md) site links the same tracker.

## Limitations

No ETA, weight or service.

## Numbers

No public source shows a whole Muser number. A parcel a universal provider filed under Muser has
MS, fourteen digits and YD, and Muser's tracker answers it, so a low rule suggests Muser for that
layout and recognition asks the tracker. The corpus holds a made-up number in that shape.

## Links

The tracker is HTTP only, so the catalog opens no carrier page.

## Testing

`npm run test:carriers:live -- carriers/muser`, with `MUSER_TRACKING_NUMBER` and optionally
`MUSER_UNKNOWN_NUMBER` set outside the repository.
