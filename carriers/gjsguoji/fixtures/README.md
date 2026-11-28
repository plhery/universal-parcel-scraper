# Fixtures

- `delivered.json`: the service's reply for the Kuaidi100 test number in `numbers.json`, without the
  parcel record (`packageInfo`), which holds the recipient's and sender's names, phones, addresses and
  identity card. Its rows keep their clocks and wordings and only the fields shown, with every mobile
  replaced by a 138 placeholder, the courier's name by 张三 and the pickup point's name by 某某.
- `not-found.json`: the service's reply for `GJS888260399001`, an invented number.
