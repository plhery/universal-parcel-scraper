# Masspack Express

Masspack Express (千百包, 深圳市金迈仕科技有限公司) runs shipping lines from China to the United
States, where a local courier delivers. Its tracker runs on AU-OPS (乐代), a forwarder platform
whose service picks the tenant by host. The adapter reads the service behind the tracker page.

## How it works

1. `direct`: one `GET https://mp.masspack-express.com/edi/pubTracking` with `soNum` (the number),
   `url=/public-tracking`, `host=mp.masspack-express.com` and `noSubTracking=true`, as the page's
   own script sends it. It needs no cookie, session, CAPTCHA or browser. Without `url` the service
   fails with HTTP 500.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The reader lives in `auOps.ts` and the platform's vocabulary in `auOpsStatus.ts`, so another
  AU-OPS tenant needs only its id and host (`adapter.ts`).
- The reply is a list with one order per number asked. The order's `trackingNum` or `jobNum` must
  be the number asked, or the answer is indeterminate.
- An order carries a state code (the label beside it) and tracking rows, each with a node code, an
  optional context and an event time. Codes and their English and Chinese wordings come from the
  platform's translations; rows are worded in Chinese for a Chinese reader. A node the platform does
  not name keeps its code, and the shared wording rules read its context.
- The state decides the stage unless the newest row is further along or a delivery. State `0`, on
  the way, is also the state of an unknown number, so the rows decide then.
- Rows for estimated dates (ETD, ETA, transfer and delivery dates) are `planned_events`, not scans.
- Only `eventTime`, the instant the page orders rows by, is read, and it must state its offset or
  be milliseconds since 1970. The row's `time` is a wall clock without a zone, so a reply without
  an instant is a schema failure.
- When the order names exactly one other number in `subTrackings`, that is the
  `delivery_tracking_number`; its carrier is named when the catalog knows the name the reply gives
  and its number rules fit. Several carton numbers name no hand-over.
- Couriers' names and phone numbers are taken out of the contexts with TMW Express's filter.
- The only not-found answer is HTTP 200 with an order marked `notFound` that holds nothing but the
  number. The page also reads HTTP 404 as not found, but the service does not send it for an
  unknown number, so any status other than 200 is a transport failure.

## Numbers

The adapter takes 5 to 40 letters and digits with at least one digit. No detection rule claims
them, so select the carrier explicitly. No public page shows an order number, and the found-order
fixture is synthetic.

## Limitations

- No place, weight, service, recipient, expected delivery or proof of delivery. The progress rail
  (`headNodes`), carton count and the customer's references are not read.

## Testing

`MASSPACK_TRACKING_NUMBER=… MASSPACK_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/masspack`
