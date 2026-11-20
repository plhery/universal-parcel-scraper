# AKR Express

AKR Express Parcel Service carries road parcels in southern India. Select **AKR Express** and enter the lorry receipt (LR) shown on the booking receipt or SMS. The public form accepts a letter followed by six or seven digits.

## How it works

The adapter submits the same form as the [carrier's public tracker](https://akrexpress.com/). It posts `action=akr_lr_track` and `lr_number` to `/wp-admin/admin-ajax.php`. The endpoint binds the response to that lookup and the page displays the submitted number beside it. The carrier returns HTTP 404 with a specific JSON message for an unavailable receipt.

AKR's [booking SMS example](https://akrexpress.com/wp-content/uploads/2020/12/iPhone-mockup-for-Services-SMS-Alerts-scaled.jpg) publishes `P125600`. The tracker still returns the booking and a current `transit` summary. Its live timeline card repeats the origin booking time under a numeric title, so the adapter uses the summary for current status and keeps the dated origin booking as the movement record. Branch times use `Asia/Kolkata` and the day/month/year format. The response describes chargeable weight, which can differ from actual parcel weight.

## Testing

`AKR_EXPRESS_TRACKING_NUMBER=P125600 npm run test:carriers:live -- carriers/akr-express`
