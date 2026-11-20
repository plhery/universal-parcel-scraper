# O.T.S. ASTRACON

Track German freight forwarder O.T.S. ASTRACON through its public
[Track Shipments form](https://www-oaoosf.wisegrid.net/Portals/NEO/Desktop).
The [carrier's site](https://www.astracon.com/en/service/track-trace-2025/)
links to that form. The adapter sends one reference to the form's guest
JSON route and requires an exact house bill, shipment ID or container match.

U.S. import records sometimes put the forwarder's `ASQR` carrier code
before its `SE` house bill. The adapter accepts that format by submitting
the house bill without `ASQR`. Shipment events use the native UTC
timestamps. The vessel itinerary can record an arrival ahead of the final
delivery, so it supplies neither a delivery scan nor a parcel ETA.
A listed container can have no tracking scans of its own.

Select **O.T.S. ASTRACON** explicitly. Run the live checks with the published numbers.

```sh
OTS_ASTRACON_TRACKING_NUMBER="$PUBLIC_NUMBER" OTS_ASTRACON_UNKNOWN_NUMBER="$PUBLIC_MISS" \
  npm run test:carriers:live -- carriers/ots-astracon/adapter.live.test.ts
```
