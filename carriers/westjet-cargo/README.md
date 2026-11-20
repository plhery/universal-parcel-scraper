# WestJet Cargo

WestJet Cargo carries domestic and international air freight through its
Canadian network. Its public SmartKargo tracker accepts an airline prefix and
an eight-digit serial on the same air waybill. The adapter uses the public
result route, follows its same-host redirect, and checks the waybill printed
on the result.

The result has separate tables for booking and acceptance, and for freight
movements. The adapter reads each table’s event clock, preserves the station
and local time, and uses the carrier’s latest activity for the current stage.
It does not treat the flight schedule column as a history clock.

The fixture comes from the live response for the waybill linked in
`numbers.json`. The guest tracker also returned a bound absent response,
included as a negative fixture.

`WESTJET_CARGO_TRACKING_NUMBER=83811594284 npm run test:carriers:live -- carriers/westjet-cargo`
