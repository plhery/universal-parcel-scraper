# Parcel Freight Logistics

Parcel Freight Logistics parcels use enabled universal providers. There is no dedicated adapter
yet.

Parcel Freight Logistics (PFL) clears and delivers cross-border e-commerce parcels in
Australia from its depots. Its site is pflogistics.com.au. It is not PFL Logistics of
Indiana.

## Numbers

Numbers customers give in public reviews read `NEXAU`, ten digits and `YQ`, and its tracker
answers them. That layout comes from a forwarding platform where the first letters name the
sender, so `pflogistics-1` stays low confidence and no rule takes other prefixes.

## Tracker

The tracking page renders the history on the server from a plain GET, without a cookie, key or
CAPTCHA, and can show the clocks in UTC.

## Links

The results page opens a number from its `tracking` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
