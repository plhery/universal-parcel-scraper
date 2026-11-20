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

The [carrier's public import listing](https://www.importgenius.com/suppliers/o-t-s-astracon-internat-air-sea)
gave the Rotterdam–Savannah house bill. A [Bremerhaven–Charleston manifest](https://www.importinfo.com/germany/north-rhine-westphalia/frechen)
gave a second bill with an explicit delivery scan. The carrier returned
dated scans for both on 20 November 2026. The fixture response keeps the
identifiers and event fields necessary to replay the history. The listed
container fixture uses the container number published with a
[separate import record](https://www.importinfo.com/elkamet-inc).

Select **O.T.S. ASTRACON** explicitly.
