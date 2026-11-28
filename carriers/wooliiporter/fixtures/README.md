# Fixtures

Synthetic replies of `/api/public/tracking/{number}`, shaped as the tracking page's script reads
them; no public number shows a shipment. `delivered.json` uses the page's example number. Its
scans give UTC and offset instants, one scan is repeated, and the first has no wording of its own.
`not-found.json` is the service's answer for a number it does not know, as it answers the page's
example number, with a made-up request id.
