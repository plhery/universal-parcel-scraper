# Western Post

Western Post (西邮物流) of Shenzhen ships large items for Chinese online sellers to its own
warehouses in North America and Europe and delivers them over the last mile with its own trucks
and partners. Its tracker follows a parcel from the warehouse that sends it to the delivery, and
gives the parcel's weight and size.

## Numbers

The public sample is `WP` and thirteen digits; the tracking box takes any number it is given.
WooliiPorter prints the same shape with a Luhn check digit, which the sample fails, and one sample
shows no check digit or range of Western Post's own, so no rule names Western Post and a declared
gap says why. The adapter takes 6 to 40 letters and digits, in capitals. The samples and their
sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `POST https://www.wpglb.com/trackQuery` with the form field
   `trackNumberList={number}`, the request the tracking box on the Chinese home page makes, with
   the `X-Requested-With` header its script adds. It needs no session, token, cookie or CAPTCHA.
   The English pages have no tracking box.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of it.

The box takes several numbers separated by spaces and posts them joined by commas, and the
tracker answers them all in one reply whose every row names its number. The adapter posts one
number and reads only the rows that name it.

The reply lists the scans newest first, each with a code, an English wording, a town and a wall
clock to the second, then the parcel's weight and sides with their units. The page shows the
town column only for replies of type 1, and the adapter reads it the same way. A town holding a
digit, as a street address or a postcode would, is dropped, and a wording that goes on to name
who signed for the parcel is cut there. The reply also counts the delivery photos, which the
page shows only to someone who types the signer's name, and names the sender's and recipient's
towns, which the page does not show; the adapter reads none of them.

A number the tracker holds nothing for gets every list empty, with no number repeated. The
lookup posts that one number and keeps no state, so the empty reply binds it and reads as not
found. Rows that name the number without a scan are a parcel listed without history. Rows for
other numbers only, or a refused lookup's message, leave the answer open. A refusal or a browser
check is a challenge, a 503 maintenance, a redirect or a missing route a transport failure, and a
page or broken JSON in place of the reply a changed reply.

There is no recognition: no detection rule offers Western Post for a number, so preflight never
asks it.

## Status

Scans are staged by their code, else by their wording, which a universal provider relays without
the code, else by the shared wording rules. The newest staged scan sets the parcel's stage.

## Clocks

The reply names no zone, so each scan keeps its wall clock in `local_time`. The clocks are the
scan town's: read on California's clock, the sample's parcel goes out for delivery early in the
morning and is delivered in the afternoon, where China's clock would put the delivery near
eleven at night in California. Node lookups date the scans on the zone of their town, else from
the scans around them or the catalog's Shanghai clock.

## Hand-over

The reply has no field for another carrier or its number, and the sample's scans are Western
Post's own up to the delivery, so the adapter names no delivery partner.

## Limitations

- No delivery estimate, destination country, instants or proof of delivery.
- The map and the clock reading rest on one parcel delivered within California. Other codes keep
  their wording, staged by the shared rules where they can be.

## Links

The tracker answers only by POST, so no address opens one shipment.

## Testing

```sh
npm run test:carriers:live -- carriers/western-post
```

It reads the public sample from `numbers.json`; `WESTERN_POST_TRACKING_NUMBER` and
`WESTERN_POST_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic
unknown number.
