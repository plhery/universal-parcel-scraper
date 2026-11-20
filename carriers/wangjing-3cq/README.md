# Wangjing 3CQ

Wangjing 3CQ (旺鲸3CQ), run by Shenzhen Wangjing Technology, ships online orders from China to
Brazil. Its site is wjdrop.com. The adapter reads the lookup its tracking page makes. Select the
carrier explicitly.

## How it works

1. `direct`: one `POST https://track.wjdrop.com/api/tracking/list` with
   `{"trackingNumbers":["<number>"]}`, with no cookie, token or browser. The JSON reply lists the
   number's scans: 3CQ's warehouse and depot in China, the export through Hong Kong, the air
   waybill's flights, Brazil's customs, and J&T Express Brazil's last mile.
2. `retry`: the same read once more after a network failure or a hang.

- The entry in the reply must be the number asked.
- The tracker lists an unknown number with no scans, which its page shows as having no tracking
  yet; that is read as not found. A non-zero `resultCode`, a 404, a page instead of JSON or any
  other malformed reply is a failure, never a missing shipment.

## Notes

- Every scan carries an instant with the offset 3CQ writes, China's, even for scans in Brazil.
  The adapter keeps that offset.
- Scans are staged by their scan code, which J&T Express Brazil's and Brazil's customs steps
  carry, and by their recorded wording otherwise. The tracker's own five-step progress value is
  not read: it files J&T's arrivals under out for delivery and its delivery round under in
  transit.
- Code 610 is both a destination pre-alert and a customs inspection, so it is read with its
  wording.

## Limitations

- J&T Express Brazil is not named as the delivery carrier, although its scans say so and the
  numbers seen are its waybills.
- No estimated delivery, weight, recipient or proof of delivery is in the reply.
- No return, failed delivery or pickup point has been seen live, so those fall to the shared
  wording rules.

## Numbers

The public samples are J&T Express Brazil waybills in its 888002 family, which 3CQ's tracker also
answers for, so there is no rule.

## Links

Tracking links carry the number as `nums` on its `tracking/index` page, which looks it up on load.

## Testing

`npm run test:carriers:live -- carriers/wangjing-3cq`, with `WANGJING_3CQ_TRACKING_NUMBER` and
optionally `WANGJING_3CQ_UNKNOWN_NUMBER` set outside the repository.
