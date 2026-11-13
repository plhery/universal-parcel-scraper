# Fixtures

The replies follow `TrackShipmentSummariesByTrackingNumbers` for one number.
`delivered.json` has a shipment's status, its delivery estimate and its scans, newest first, with
wall clocks to the millisecond and no offset. Places are written as the reply writes them, in
capitals or not and with or without spaces after the commas. Unset clocks are year 1.
`not-found.json` is the service's answer for a number it does not know.

The fields the adapter never reads, such as the recipient's address, the signer and the
shipper's reference, are left out. Numbers, places and clocks are invented.
