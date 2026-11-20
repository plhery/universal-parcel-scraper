# LX Pantos

LX Pantos (LX판토스, formerly 범한판토스) is the LX group's logistics company in Seoul: an international
forwarder and contract logistics firm that also ships cross-border e-commerce parcels into Korea.

## How it works

The adapter does what the e-commerce portal's tracking page does, over plain HTTP and without a
login. It posts the number to `/eCommerce/action/portal.TrackingPopup.retreiveTrackingList`, takes
the shipment the number names, then posts that shipment's house bill, master bill and business type
to `retreiveTrackingListDtl` for its scans.

The scans carry the wall clock of the country they name, without a zone, so they stay local clocks.
The search's row adds the recipient's romanized name, the destination country and the Korean courier
that delivers the parcel. That courier and its number are handed on only when the courier's own rules
offer the number.

## Numbers

The search takes a house bill, the delivering courier's number or a master bill, up to 30 at once.
A master bill names every shipment it consolidates, so it is read only when it names one. Express
house bills start with `P`, the origin country and the year, but the tracker publishes no layout, so
there is no detection rule.

## Limitations

- The service answers rapid lookups with HTTP 429; the adapter reports it as a transport failure.
- Each delivery step has a sub-detail with the driver's name and phone number. The adapter does not
  ask for it.
- The freight route on `visibility.lxpantos.com` answered nothing for the ocean house bills in
  `numbers.json`, so ocean shipments remain with the universal providers.

## Links

The e-commerce portal's tracking box opens the tracking page with the number in `quickNo`, and the
page searches on load; the catalog reads the number from `quickNo`.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/lx-pantos
```

`LX_PANTOS_TRACKING_NUMBER` overrides the public sample.
