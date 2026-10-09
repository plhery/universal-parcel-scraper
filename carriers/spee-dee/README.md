# Spee-Dee

Tracks Spee-Dee Delivery Service barcodes (`SP` and 16 or 18 digits) through the package
progress page behind the detail view of the
[official tracking page](https://speedeedelivery.com/track-a-shipment/).

## How it works

1. `direct`: one anonymous
   `GET https://packages.speedeedelivery.com/package_progress.php?v=detail&barcode={number}`.
   The website's tracker frames `track_shipment.php` on the same host, a summary without
   the scans; its detail view frames `packageDetail.php`, which answers a permanent
   redirect to this page. Spee-Dee publishes no tracking app, and the page needs no
   credential, cookie or session. The number is checked before any request, the read stops
   at 256 KB, redirects are not followed and the request gives up after 10 seconds.

## Notes

- Every HTML comment is removed before parsing: the page has carried debug dumps there with
  the recipient's address, the signer and device data, one dump per scan. The read cap
  leaves room for them.
- The page must name the requested barcode in its summary and above the progress table, and
  no other barcode. Only the exact "No packages were found matching the barcode supplied."
  page is not found. A challenge title or widget counts only on a page without the
  package, so a bot-detection script next to the tables hides nothing.
- Barcodes are reused, so one page can list several shipments, newest first. A delivery row
  below a later scan, or a day or more away from the delivery row above it, closes an
  earlier shipment: it and every older row are dropped. Back-to-back delivery rows within a
  day are one delivery scanned twice.
- The summary must describe the newest delivery, or for a barcode still moving, an earlier
  one. A summary that reports a delivery the table does not show, or a different status
  next to a delivery row, makes the answer inconclusive: it may describe a newer shipment
  without scans.
- Scan times are wall clocks without an offset, kept in `local_time`. The footer states
  Central Time, but the network also serves Eastern-time states, so no zone is assigned,
  as for other US carriers spanning several zones.
- The route number after "OUT FOR DELIVERY" is dropped. The signer, delivery address and
  proof of delivery are never read.
- The canary probes the public tracking page, since the lookup host does not answer many
  networks.
- The site's terms limit tracking to shipments sent by or for the person asking.

## Limitations

- The host drops or refuses connections from many networks, including common cloud ranges.
  That is a transport failure, never not found, whose message says the host refuses some
  networks; a deployment needs a network the host accepts. A failed name lookup, a bad
  certificate, or a reply that starts and then breaks or stalls is a plain transport
  failure.
- An earlier shipment that did not end in a delivery cannot be told apart from the current
  one, and any scan after a delivery is read as the start of a new shipment.
- A barcode reused for a new shipment that has no scans yet is answered with the previous
  delivery, unless the summary already describes the new shipment. Nothing else on the page
  tells the two apart.
- A barcode with a summary but no progress rows is inconclusive.
- No ETA, weight or delivery instant.

## Testing

`npm run test:carriers:live -- carriers/spee-dee` sends a well-formed unknown barcode and
skips only when the connection is dropped or refused or no reply starts within the request
limit; any other failure fails it. Set `SPEE_DEE_TRACKING_NUMBER` to read the history of an
authorized real barcode.
