# TFMXpress

TFMXpress is an Australian road express carrier with its own depots in the capital cities and
agents in the regions. Tracked through the FreightTrax tracker its site links, which runs on the
EzyFMS freight platform. It is not [TFM Express](../tfm-express/README.md), the Dubai courier.

## How it works

1. `direct`: one `POST https://www.ezyfms.com/tfm/Tracker.asp` with the form body
   `CN={number}&PC=`, as the tracker's form sends it. The postcode field is optional and left
   empty: the tracker shows the history without it, with the notice "Please enter correct
   destination postcode." above. No cookie, token, CAPTCHA or browser is needed.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The server renders the consignment's card and its rows. The number comes back only as the
  value of the form's `CN` field, which must be the whole number asked; another number is
  inconclusive.
- A number the tracker does not know gets "The tracking information is not available." in place
  of the card, read as not found. A page without its form or table, or a row the parser cannot
  read, is a schema failure; HTTP 401/403 or a bot check is a challenge.
- [ezyfms.ts](ezyfms.ts) holds the request and the parser. Another carrier on EzyFMS can declare
  an `EzyFmsTenant` with its path on www.ezyfms.com, its zone and its status map.

## Notes

- Rows come oldest first with a clock, a status and a depot, and are returned newest first.
  Clocks are wall times with no zone, kept as `local_time`. A depot named after an Australian
  city gives its city's zone (`time_zone_basis: place`): a consignment can be picked up in
  Melbourne and delivered in Adelaide, half an hour behind. Any other depot is read on
  Melbourne's clock, the carrier's (`time_zone_basis: carrier`).
- The status wording stages each row. `POD REGISTERED` records the proof of delivery just after
  the delivery row and is delivered too; `delivered_at` is the delivery row's time.
- The card's ETA date is kept as `expected_delivery`.
- Pickup and delivery rows carry a signature image and the signatory's name, which are not read.
  The proof of delivery the page opens through `jsdata/DownloadPOD.asp` is not fetched.

## Limitations

- No sender, receiver, service, weight or item count: the card shows the sender and receiver
  only as labels.
- Only the wordings in [statuses.json](statuses.json) have been seen; others go to the shared
  wording rules.

## Numbers

The public sample is six letters and five digits, the letters apparently a sender's code. One
sample does not show which letters are fixed, so no rule claims the shape and the gap is
declared. Select TFMXpress explicitly. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

`https://www.ezyfms.com/tfm/Tracker.asp?CN={number}` opens the tracker on the number: the page
answers a GET as it answers its form.

## Testing

`npm run test:carriers:live -- carriers/tfmxpress`, with `TFMXPRESS_TRACKING_NUMBER` and
optionally `TFMXPRESS_UNKNOWN_NUMBER` set outside the repository.
