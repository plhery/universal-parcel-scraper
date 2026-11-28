# Fixtures

- `delivered.json`: the FlowLink route's reply for Kuaidi100's test number in `numbers.json`, a parcel from the
  Hong Kong warehouse handed to STO at Shenzhen and collected from a parcel station.

The reply is trimmed to the fields the parser reads. The recipient's masked name and address, the last four digits
of their phone, the port and the relay's status fields are left out. In the rows STO relayed, the couriers' names
are written 某某 and their phones and the branches' phones are replaced by numbers of the same shape.

The route answers a number it does not know with `ErrorCode` `NotExistsCNum`, which the tests write inline.
