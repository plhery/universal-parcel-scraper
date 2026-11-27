# Fixtures

- `delivered.json`: the portal's reply for the Kuaidi100 example waybill in `numbers.json`. Its rows
  keep their clocks and wordings, with the signer's name replaced by 张三 and the branch's enquiry
  phones by stand-in digits. The waybill record in `Data2` keeps only the waybill and cargo numbers, without the
  shipper's and consignee's names, phones and addresses; the branch contacts in `Data3` and the page
  template in `Data4` are null.
- `not-found.json`: the portal's reply for `ANYT1901010317`, an invented number, with the page
  template in `Data4` null.
