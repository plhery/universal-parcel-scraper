# Fixtures

- `in-transit.json`: the FlowLink route's reply for Kuaidi100's example number in `numbers.json`, a parcel from
  the Los Angeles warehouse cleared in China and handed to SF Express.

The reply is trimmed to the fields the parser reads. The recipient's masked name and address, the last four digits
of their phone, the port and the relay's status message are left out.

The route answers a number it does not know with `ErrorCode` `NotExistsCNum`, which the tests write inline.
