# ATC Logistical Solutions

ATC Logistical Solutions is an Indian road transporter: a consignment travels from its booking
branch, such as Naraina in Delhi, through hubs to a delivery branch or partner transporter. Its
tracker at `atcsure.com` takes the LR number on an ATC consignment note.

## How it works

1. `direct`: asks `atcsure.com/proxy.php?action=trackntrace_website` with the number as
   `jsonreq={"GC_No":…}`, as the Track Shipment form does. The lookup answers the address of the
   number's `tracking.php` page, or `Invalid LR No.`, which is not found. The adapter then reads
   that page, whose script holds the tracker's reply as a JSON string.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- Neither request asks for a session or a check.
- The page's `gc` is a token the lookup builds from the number, not the number, so the page is
  reached only through the lookup. A token the tracker does not know gives a reply without a
  consignment, which reads as indeterminate rather than not found.
- The reply must name the number asked.

## Notes

- The consignment's own milestones are its booking, its arrival at the delivery branch, the
  delivery run and the delivery. Between them, each manifest is a leg from one branch or hub to
  the next: its date is a dispatch and its unloading sheet an arrival. The last leg's unloading at
  the delivery branch is that branch's arrival milestone, so it is given once.
- The dispatch date stands alone only for a consignment without manifests, as it repeats the
  latest manifest's.
- The statuses and their wording come from the steps the page's script draws.
- Dates keep the tracker's wall clock. Manifests give a date alone, and the tracker writes
  midnight for a milestone without a time.
- Names, phone numbers, the delivery address, the invoice, charges, vehicles, drivers and staff
  codes stay behind. Branches and hubs are the locations.
- atcls.net's Track Shipment button opened an external tracker on a bare address; the tracker
  that still answers there gives less detail.

## Limitations

- No delivery estimate. The proof of delivery photographs are left out.

## Numbers

The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/atc-logistical`

The live test tracks the public sample in `numbers.json`; `ATC_LOGISTICAL_TRACKING_NUMBER` tracks
another consignment note, and `ATC_LOGISTICAL_UNKNOWN_NUMBER` replaces the invented number of the
not-found check.
