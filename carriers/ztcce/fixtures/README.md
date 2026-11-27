# Fixtures

- `las-vegas.json`: the service's reply for Kuaidi100's example in `numbers.json`, a waybill from the Las Vegas
  warehouse.
- `austin.json`: the service's reply for Kuaidi100's test number, a waybill from the Austin warehouse.

Both replies keep everything but the recipient's city in `endcity`, written `*`. Their `phone` is empty.

The service answers a number it does not know with an empty body, which the tests write inline.
