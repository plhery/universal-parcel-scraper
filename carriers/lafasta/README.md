# Lafasta

Select Lafasta to read a Saudi consignment's public tracking history. The results page
must show the entire tracking number searched.

Scan dates omit their year. The adapter reads the timeline forward from the shipment date
in the same reply and carries the year across December and January. It keeps the carrier's
wall clocks, event wording and scan locations.

Set `LAFASTA_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/lafasta`.
