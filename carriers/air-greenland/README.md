# Air Greenland Cargo

Air Greenland carries air freight within Greenland and on international routes.

The public tracking page calls `/umbraco/api/Calculator/track` with one air
waybill. The adapter requests the English reply and checks that the waybill in
the JSON matches the request. It retains airport locations, flight numbers
shown in the scan descriptions, and the cargo weight.

The reply can repeat scans and report one movement for each group of pieces.
The parser removes duplicate rows, treats an airport handling-agent handover
as a transit event, and only reports delivery when the destination scans
account for the whole shipment. It omits named recipients. Scan dates do not
include a year or offset, so the adapter preserves them as displayed in the
carrier's order.

The fixtures come from the carrier's published tracking example and two
University of Copenhagen EastGRIP reports linked in `numbers.json`.

`AIR_GREENLAND_TRACKING_NUMBER=63127774563 npm run test:carriers:live -- carriers/air-greenland`
