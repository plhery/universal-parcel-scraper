# Fixtures

Replies of Airmee's public lookup, `api.airmee.com/track/public_track_shipment`, as its tracking page asks it.

- `delivered.json`: the reply for a public sample in `numbers.json`, an Amazon shipment with a failed attempt, a
  delay and its delivery.
- `returned.json`: the reply for another public sample, an Amazon shipment with two failed attempts, the van's
  repeated position rows and its return to the sender.
- `not-found.json`: the reply for a synthetic id of the Amazon shape that the tracker does not know.

In both samples the recipient's town and postcode are replaced with placeholders and the courier's positions on
the warehouse scans are taken out. The replies name no person and give no phone number.
