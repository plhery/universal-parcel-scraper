# HOP Envíos

Select HOP Envíos to read the tracking history for an Argentine parcel. The public tracking
page embeds the shipment and its scans. The adapter checks the submitted code and returned
shipment number before using the history.

The scan clocks stay local unless the page supplies an offset. The positive fixture comes
from the carrier's archived tracking page. The live tracker reports that sample as missing.

Set `HOP_ENVIOS_TRACKING_NUMBER` to a current shipment or
`HOP_ENVIOS_UNKNOWN_NUMBER` to check absence, then run
`npm run test:carriers:live -- carriers/hop-envios`.
