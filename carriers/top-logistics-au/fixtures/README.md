# Fixtures

Pages of `imshk.toplogistics.com.au/customerService/imparcelTracking?s=<number>`, the frame Top Logistics'
site search opens.

- `delivered.html`: the page for the public sample in [`numbers.json`](../numbers.json), a parcel shipped by sea
  from Shekou and delivered in Melbourne by Allied Express. The head's styles and the chat widget are left out,
  the head's commented-out reCAPTCHA script is kept without its site key, and the recipient's postcode in the
  page's script is replaced with zeros.

An invented number gets an empty HTTP 500, which the tests build inline.
