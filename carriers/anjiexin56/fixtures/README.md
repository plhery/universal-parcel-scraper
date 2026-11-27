# Fixtures

- `delivered.json`: the portal's reply for the Kuaidi100 test number in `numbers.json`. Its rows are
  unchanged. The waybill record in `Data2` keeps only the waybill and cargo numbers, without the
  shipper's and consignee's names, phones and addresses; the branch contacts in `Data3` and the
  page template in `Data4` are null.
- `not-found.json`: the portal's reply for `70318294`, an invented number, with the page template in
  `Data4` null.
