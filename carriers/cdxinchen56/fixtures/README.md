# Fixtures

- `delivered.json`: the portal's reply for the Kuaidi100 example waybill in `numbers.json`. Its rows
  keep their clocks and wordings, with the signer's name replaced by 张三. The waybill record in
  `Data2` keeps only the waybill and cargo numbers, without the shipper's and consignee's names and the
  firm's phone; the branch contacts in `Data3` are null.
- `not-found.json`: the portal's reply for `1999999999`, an invented number.
