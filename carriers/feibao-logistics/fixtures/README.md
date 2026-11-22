# Fixtures

The endpoint's replies for waybills kuaidi.com's Feibao page lists, with the recipient's and
sender's names and phones replaced by placeholders, the full waybill records trimmed to their
numbers and the map links dropped. The track rows are as received.

- `delivered.json`: `119033244150`, from a Beijing branch through the Beijing hub to Xinyi, signed
  for.
- `out-for-delivery.json`: `F00002866447`, from Shenzhen through Dongguan and Haikou, out for
  delivery at Baisha.
- `signed-twice.json`: `F00002864814`, from Guangzhou to Chongqing, with two signature rows.
- `not-found.json`: the reply for the synthetic `F99999999990`.
