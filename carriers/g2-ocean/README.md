# G2 Ocean

Select G2 Ocean explicitly and enter the bill of lading number. The [MyG2 Cargo Tracker](https://myg2.g2ocean.com/cargo-tracking) offers a public bill search. The adapter accepts the carrier-issued number with or without the GSSW manifest prefix.

## Retrieval

The adapter reads port calls attached to the matching bill. It keeps actual loading-port arrivals, berthings and departures and actual arrival and berthing at the discharge port. The result records the vessel's port milestones and the local times printed by MyG2. It excludes estimates and the vessel's departure from the discharge port.

Departure from a loading port and arrival or berthing at a discharge port count as transit. Arrivals and berthings at loading ports remain visible as vessel movements.

## Testing

`G2_OCEAN_TRACKING_NUMBER=… G2_OCEAN_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/g2-ocean`
