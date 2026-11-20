# DANX

DANX, part of the Carousel group, distributes spare parts overnight in the Nordic countries and the
Baltics, and carries shipments booked by its customers, such as the samples clinics send to the
University of Copenhagen's veterinary lab. Its tracker takes the barcode on a DANX label.

## How it works

1. `direct`: asks `fasttrack.danx.com/FastTrackService.asmx/GetShipmentDetails`, the service
   behind the tracker page that the tracking form at `login.danx.com` opens. Its `id` is that
   page's own address, `fasttrack.danx.com/?id=` and the number in base64, appended as the page's
   script appends it. An empty table is not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- Neither the form nor the service asks for a session or a check. The guest tracker at
  `service.danxils.com`, which Cloudflare challenges, belongs to DANX powered by ILS in Poland.
- The service answers JSON only when the request says it sends JSON, as the page's script does;
  otherwise it returns an error page.
- A row must name the number as its barcode or its other reference.

## Notes

- A customer's labels are used again, and the tracker lists every shipment under a barcode: the
  adapter follows the newest. A reference that several labels share names none of them.
- The status codes and their wording come from the legend under the tracker's table. `CNA`
  stands for a failed pickup as well as a failed delivery, so it reads as an exception.
- Scans keep their wall clock: the reply gives no zone, and DANX's terminals span two time zones.
- A delivery scan names its signer, which is left out with the names, addresses, weight and
  notes. The terminal of any other scan is its location.
- The link the tracking form opens carries the number in base64, which link rules cannot read.

## Limitations

- No delivery estimate or proof of delivery.

## Numbers

A customer's labels follow that customer's own series. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/danx`

The live test tracks the public sample in `numbers.json`; `DANX_TRACKING_NUMBER` tracks another
barcode, and `DANX_UNKNOWN_NUMBER` checks the not-found answer.
