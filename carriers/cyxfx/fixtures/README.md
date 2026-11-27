# Fixtures

- `delivered.json`: the service's reply for the Kuaidi100 example in `numbers.json`, with the recipient's name and
  street address in `addr` replaced by an asterisk, the customer service agent the customs remark names replaced
  by an asterisk and her mobile by a synthetic number, and the operators' user ids set to 0.
- `not-found.json`: the service's whole reply for an invented waybill far beyond the range in use.

The tests add a synthetic SF Express route to the hand-off row; the public sample's row carries SF's number
without route scans.
