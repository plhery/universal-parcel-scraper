# Parcel2Go

Parcel2Go arranges UK and international deliveries through partner couriers. The adapter
looks up its own P2G reference through the same guest JSON service as the public tracker.
The order-line id in the reply must match the whole reference. Status scans are supplied
by the partner courier and relayed by Parcel2Go.

The tracker can return several pieces for one reference. The adapter follows an unfinished
piece until all pieces are delivered. It keeps the scan's stated offset when present and
preserves offsetless partner clocks as wall time. It omits scheduled slots, estimates,
photos and recipient details. Partner tracking numbers can be used with the corresponding
courier. Select Parcel2Go explicitly for a P2G reference.

## Testing

`PARCEL2GO_TRACKING_NUMBER=… PARCEL2GO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/parcel2go`
