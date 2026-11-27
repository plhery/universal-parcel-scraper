- `synthetic-delivered.json` is synthetic: no public air waybill of Skynet Express India is known. It follows the
  reply the tracking page's script reads from `POST https://www.skynetww.com/api/tracking` (`results` with `found`,
  `provider`, `category`, `statusLabelKey`, `route`, `detailRows`, `carrierUrl` and `events` newest first), with
  the label keys the page translates, the scan wording and clock layout of the tracker's own test booking, and
  invented numbers, places, clocks, names and links.
- `not-found.json` is the service's reply to the `TEST00000000` placeholder.
