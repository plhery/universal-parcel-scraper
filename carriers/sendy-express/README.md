# Sendy Express

Sendy Express delivers parcels in Peninsular Malaysia with its own hubs and vans, whose drivers it
calls captains. Its tracker at `www.sendy.com.my/en/track` takes the number on a Sendy label.

## How it works

1. `direct`: asks `www.sendy.com.my/tracking/<number>?lang=en`, the JSON lookup the tracking page
   makes. HTTP 422 with `{"error":"track_info_no_update"}`, which the page words "The tracking
   information has not been updated", is its answer for a number it holds nothing under, and reads
   as not found. Any other 422 says nothing about the parcel.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- The lookup asks for no session or check. HTTP 429 is its rate limit; Cloudflare stands in front.
- The reply must name the number as its own, its reference or one of its pieces.

## Notes

- Each scan carries its instant (`created_at`, UTC). The page's day and time beside it are the same
  instant on Malaysian time, without a year.
- A scan's location is the hub it names. A delivery names none, as it happens at the recipient's
  address.
- The parcel's status (`info.status`) gives the result its stage; the scans' keys (`en_name`) give
  theirs. The wordings of the parcel statuses come from the page's script.
- Scan wordings name the recipient and the captain with his phone: each is cut before the first
  person it names or reaches, so "Parcel Out for Delivery by Captain …" reads "Parcel Out for
  Delivery". Names, phones, addresses, the van's plate and position, and proof-of-delivery images
  stay behind.
- A scan that hands the parcel to another courier names that courier after its wording, as the page
  does. No sample shows its tracking number, so there is no hand-off.

## Limitations

- No delivery estimate: the page's estimate is an hour range in a scan's wording or a clock
  without a date.

## Numbers

The public samples are `SD`, a letter and seven digits. They and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/sendy-express`

The live test tracks the public sample in `numbers.json`; `SENDY_EXPRESS_TRACKING_NUMBER` tracks
another number, and `SENDY_EXPRESS_UNKNOWN_NUMBER` checks the not-found answer.
