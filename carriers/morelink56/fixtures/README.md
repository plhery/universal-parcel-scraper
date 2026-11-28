# Fixtures

- `found.json`: the search's reply for the public sample in `numbers.json`, without each row's `podfile`, `podfile1`
  and `picture`: the proof of delivery link and pictures stay out of the repository.
- `not-found.json`: the reply for an invented number, far from the sample's, which the tracker does not know.
- `refused.json`: the reply for a verify code that does not match the picture.
- `expired.json`: the reply for a search sent without a session holding a code.
- `captcha-vhy5.jpg`, `captcha-tweh.jpg`, `captcha-fcgp.jpg`, `captcha-bc3m.jpg`: verify code pictures the tracker
  serves, named by the code the tracker accepted for each, in lower case, as the tracker takes letters in either case.

None of the replies carries a name, address or phone.
