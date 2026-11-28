# Airmee

Airmee (Airmiz AB) is a Swedish and Danish same-day and evening e-commerce courier, with pickup
points and parcel lockers. Its site is airmee.com; its tracker is tracking.airmee.com.

## Numbers

The tracker finds a shipment by the id its retailer gave it: AM and nine digits for Amazon's
parcels, a retailer's own order number, or one of Airmee's six-character codes. AM and nine digits
is the shipment id Amazon gives the parcels it hands to Airmee, and every such parcel seen was
Airmee's, but GLS Italy's rule takes any two letters and nine digits, so `airmee-1` offers Airmee
for it at low confidence and recognition settles it. Order numbers and the short codes are other
carriers' shapes too, so no rule takes them; a declared gap gives the reason for nine-digit order
numbers. The adapter takes 4 to 40 letters and digits with at least one digit, in capitals. The
samples and their sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://api.airmee.com/track/public_track_shipment?shipment_id={number}&min_date=2018-01-01&max_date={tomorrow}`,
   the request the tracking page's script makes, with the page's origin. It needs no session,
   token or cookie. The page asks for shipments inside a date range; the adapter asks from a day
   before any shipment the tracker keeps to tomorrow in UTC, so no shipment falls outside it.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the budget.
   The first try gets half of it.

The reply is a wrapper with a status code and the shipment as a JSON string. The shipment repeats
its id, in capitals whatever case was asked, and the adapter keeps it only for that id. An id the
tracker holds nothing for gets an empty shipment, `{}`, read as not found. A wrapper with another
status code, or HTTP 400, leaves the answer open; a refusal or a browser check is a challenge, a
503 maintenance, a redirect or a missing route a moved tracker, and anything that is not the
wrapper a changed reply.

Recognition makes the same lookup for the numbers `airmee-1` offers: a shipment is known, the empty
shipment unknown, and anything else stays open.

## Status

Each timeline row carries a courier status code. The page words a row by its code, its leg, out to
the recipient or back to the sender, its reason and its service; the adapter words it the same way
and stages it by code and wording. Where the page shows the bare code, a drive back to the sender
is worded "In Return Transit" as the page words the other moves back, and a courier on the way to
collect "Pickup in Progress". A row that names no leg, as an older history's warehouse scans do
not, takes the leg of the row before it, so the scans after a return began read as the trip back.
Booking changes keep the parcel's stage.

The tracker repeats the courier's drive to the door as the van moves; a run of the same row keeps
its first. The newest staged row sets the shipment's stage. A shipment without rows stands on its
courier status.

## Clocks

Every row's instant states its offset, UTC, and keeps it, to the second.

## Estimates

A delivery not yet made gets the drop-off window, from its start to its end, in the recipient's
zone. A delivered, returned or cancelled shipment, or a return booked by the retailer, gets none.
A window in another shape is named in `unread_estimates`.

## Privacy

The adapter never reads the recipient's town and postcode, the courier's positions, the order id,
the delivery options or the booking changes. The retailer is the sender, except on a return the
retailer booked, which goes back to it.

## Limitations

- Rows carry a place only for warehouse scans.
- The pickup window, the ETAs and the delivery attempts left are not read.
- The text-message links Airmee sends ask for the recipient's phone; the adapter does not use them.

## Links

The shipment page takes the id and the date range in its fragment.

## Testing

```sh
npm run test:carriers:live -- carriers/airmee
```

It reads the first public sample from `numbers.json`; `AIRMEE_TRACKING_NUMBER` and
`AIRMEE_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic unknown id.
