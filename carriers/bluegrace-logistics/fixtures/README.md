# Fixtures

`tracking-page.html` is the tracking page cut down to the settings its scripts read: the tracking
lookup's nonce and the site search's beside it. The nonces are invented.

The JSON files are replies of the `bluegrace_shipment_search` lookup for public samples, cut down
to the fields the parser reads; the parties keep only their state and country.
`delivered-ltl.json` is an LTL shipment from California to Washington with estimate and
appointment rows, a delay, and an unloading and an arrival recorded at the same minute.
`truckload.json` is a truckload from Texas to Arizona whose PRO number is its bill of lading.
`split-state.json` ends in Florida, with an estimate row that has no place.
`integration-test.json` is the record BlueGrace keeps for its integration tests, and
`not-found.json` the answer for a number the tracker does not know.
