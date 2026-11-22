# Zippd

Zippd parcels use enabled universal providers. There is no dedicated adapter.

Zippd, formerly DeliveryApp, delivers online orders in the United Kingdom the same day or the
next, and runs collections and trunking, with owner-drivers and partner fleets. Parcel resellers
also sell its service. Its site is zippd.com.

## Numbers

The tracking page's example starts with DA and adds six letters or digits, then groups of five and
eight digits, but it is made up. Codes for Myprotein orders in reviews on Zippd's Trustpilot page are
the order's eight letters and digits, then groups of six and eight digits; they are in
[`numbers.json`](numbers.json). Neither shape is settled, so there is no rule.

## Why there is no adapter

The tracking page reads the code from its address. It renders the delivery and polls
`GET https://www.zippd.com/wp-admin/admin-ajax.php?action=get_delivery_data&code={code}&email=`, which
answers JSON with the status, its milestones, the sender and the recipient, without a login or CAPTCHA.
A malformed code gets `The code provided is in an invalid format.` and an unknown one `No delivery
found with those details`. The reviews' codes resolve, but only to `status-unknown` with no
milestones, so no status of Zippd's has been seen on a known delivery. The reply also holds the
recipient's name, phone, email and address and the delivery PIN, which an adapter must drop.

## Links

Tracking links carry the code as `code` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
