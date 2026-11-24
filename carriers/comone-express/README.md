# ComOne Express

ComOne Express (商壹国际物流) is a Shenzhen forwarder founded in 2011, with its own companies in Malaysia,
Singapore and Hong Kong, carrying parcels from China to Southeast Asia. Its site is com1logistics.com.

## How it works

1. `direct`: posts the form `number=<number>` to `service.com1logistics.com//pod/track/query`, as the
   tracking page's script does for each number it was given. The reply lists the parcels ComOne holds
   under the number, each with its waybill, its status code, its destination country, the supplier
   that delivers it and its scans, newest first.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, key or CAPTCHA. The page first sends the typed text to `//pod/track/formatNumbers`,
  which only splits it into numbers; the adapter takes one number and skips that step.
- The adapter keeps the parcel whose waybill is the number asked; a reply without one leaves the
  answer open.
- A number the tracker holds no parcel under gets `code` 0 with an empty `data` list, with HTTP 200,
  read as not found. The reply does not repeat the number; the request for it does. Any other
  refusal leaves the answer open, and a refusal asking to slow down is a rate limit. A block page
  is a challenge, a redirect or a missing route a moved tracker, and a page in place of the JSON a
  changed reply.

There is no recognition: no detection rule offers ComOne for a number, so preflight never asks it.

## Status

Each scan has a code, such as `SD` or `OFD`, an English and a Chinese wording, a place and a time.
The code sets its stage from [`statuses.json`](statuses.json), else the shared rules read the English
wording. Import clearance under way is customs; its success and the export clearance before the
sailing are transit. Loading the driver's van keeps the warehouse's status code in ComOne's reply, so
it stays in transit until Out For delivery. The newest staged scan sets the parcel's stage. The
parcel's status code stands in when no scan has a stage, and alone for a parcel without scans, only
for the two codes the page's script names: 80 lights its Delivering step and 90 Delivered.

## Clocks

The reply and the page give each scan a wall clock without a zone, and the page prints it as it
comes. The scans read on the clock of their place: the samples' Singapore delivery rounds run from
the morning to the afternoon. China, Malaysia and Singapore are all on UTC+8, so the clocks agree
whichever country a scan was made in. The scans keep their wall clock in `local_time`, and Node
lookups date them on the place's zone, else the catalog's Shanghai clock.

## Hand-over

The parcel names the supplier that delivers it and, when it has one, the supplier's own number. The
supplier becomes the delivery carrier when its name is one catalog carrier's and that carrier's rules
fit that number, else the number asked; the supplier's number becomes the delivery number. The
samples' Singapore supplier, SPRX-SG, is no catalog carrier.

## Notes

- The destination country is read; the origin is ComOne's Shenzhen hub.
- The merchant's order number, the weights, internal ids, the remarks, which name the driver and the
  sailing, and the delivery photos and signature are never read.

## Limitations

- No delivery estimate, instants or service name.
- The map holds the codes seen with the samples. A new code keeps its wording, staged by the shared
  rules where they can.
- The tracker forgets a parcel after some months: an older public sample now gets the empty list.

## Numbers

ComOne's waybills seen are nine digits, a shape many carriers share, and its site gives no number
layout, so detection has no rule. The adapter takes 6 to 40 letters and digits with at least one
digit. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page's `trackNo` parameter fills its field and looks the number up on load.

## Testing

`npm run test:carriers:live -- carriers/comone-express`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`COMONE_EXPRESS_TRACKING_NUMBER` tracks another number, and `COMONE_EXPRESS_UNKNOWN_NUMBER` another
unknown one.
