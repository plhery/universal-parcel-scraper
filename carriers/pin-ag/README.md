# PIN AG

PIN AG (PIN Mail) delivers letters and parcels in Berlin, Amazon parcels there among them, and
hands items for the rest of Germany to partner posts. Link only: the app opens PIN's own
tracking page, which reads the number from its `sendung` parameter. No universal provider
covers PIN AG, and there is no adapter yet.

## Numbers

PIN publishes no layout. The numbers typed into its tracking page, as the Wayback Machine
archived them, are sixteen digits opening `0100` and carry no check digit. Sixteen digits are
low rules of several carriers, so `pin-ag-1` stays low and only lists PIN AG first.

## Leads

The tracking page reads `GET https://sendungsverfolgung.pin-ag.de/api2/tracking?sendung={number}`,
which answers a status list without a postcode; the recipient's postcode unlocks more detail.
Its reply also holds address fields, which an adapter must not read. PIN's FAQ asks for the
number without the brackets a label can print around part of it.

## Limitations

Only items PIN tracks have history: registered letters, parcels and Amazon parcels in Berlin.
Standard letters do not.
