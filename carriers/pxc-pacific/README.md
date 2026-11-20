# PXC Pacific Global

PXC Pacific Global Private Limited, in Mumbai, is an international courier and freight forwarder and
an IATA agent, with a UK arm, Pacific Express Corporation, near London. Its site is pacificexp.net.
The adapter reads the lookup its tracking page makes. Select the carrier explicitly.

## How it works

1. `direct`: one `POST https://eship.pacificexp.net/api/v1/Tracking/Tracking`, the open JSON
   service of Xpresion, a courier management system, with the number in `AWBNo`, `Type` `A` for an
   air waybill, `RequiredUrl` `yes` and the fixed login the tracking page sends for every visitor.
   There is no cookie, session, CAPTCHA or browser. The reply lists the shipment and its scans:
   PXC's hub in Mumbai, its export gateway, the transit point in Kuala Lumpur, the import gateway,
   and the delivering partner's scans from its booking in India to delivery.
2. `retry`: the same read once more after a network failure or a hang.

- The shipment in the reply must be the number asked.
- An unknown number gets HTTP 200 with "AWB does not exist" and no shipment, read as not found.
  The page itself waits for "AWB No not found", which is read the same. Any other refusal, a 404,
  a page instead of JSON or any other malformed reply is a failure, never a missing shipment.
- A listed shipment without scans has no history and still hands on its partner's number.

## Notes

- Scans carry a date and a time of day without a zone. They come from Mumbai, Kuala Lumpur and
  the destination, each on its own clock, so they stay wall clocks.
- The page's "Tracking Number" is the delivering partner's number for the parcel, which the
  adapter hands on. The partner is named when its name, or the tracking link the page opens for
  that number, is a catalog carrier. The partners seen are DTDC Australia, for Australia and New
  Zealand, which is not in the catalog, so only its number is handed on.
- Scans are staged by their code and recorded wording. PXC's own steps carry letter codes and
  capitals; the partner's carry numeric codes.
- The shipper, consignee and receiver names, the reference, the weight, the booking and delivery
  summary and the proof-of-delivery flags are in the reply and not read.

## Limitations

- No estimated delivery, return or failed delivery has been seen live, so those fall to the shared
  wording rules.
- The service's reference lookup, `Type` `R`, is not used.

## Numbers

The public samples are ten digits, a shape other carriers share, so there is no rule.

## Links

Tracking links carry the number as `awbno` on the tracking page, which looks it up on load and
takes several numbers separated by commas.

## Testing

`npm run test:carriers:live -- carriers/pxc-pacific`, with `PXC_PACIFIC_TRACKING_NUMBER` and
optionally `PXC_PACIFIC_UNKNOWN_NUMBER` set outside the repository.
