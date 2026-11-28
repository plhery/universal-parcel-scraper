# Fixtures

- `delivered.json`: the portal's reply for the Kuaidi100 test waybill in `numbers.json`. Its rows keep
  their clocks and wordings, with the truck's plate replaced by 皖A00000. The waybill record in
  `Data2` keeps only the waybill and cargo numbers, the carrier's name, the state, the two cities and
  the dates, without the shipper's and consignee's names, phones and addresses; the branch contacts
  in `Data3` and the page template in `Data4` are null.
- `not-found.json`: the portal's reply for `6613899001`, an invented number, with the page template
  in `Data4` null.
