# Fixtures

The pages are trimmed to their form and tracking sections; the ASP.NET state fields carry
synthetic values.

- `home.html`: the home page's consignment search.
- `invalid-number.html`: the home page's answer to the synthetic `ABC999999999`, a station code
  TPC does not take.
- `captcha.html`, `captcha-refused.html`: the captcha page, and its answer to a wrong reading.
- `summary.html`, `verify.html`, `delivered.html`: the tracking page's summary, its code check and
  its details for the newest Voxya sample in `numbers.json`: booked in Kanpur, through Chennai
  and Bengaluru South, misrouted once and delivered.
- `not-found.html`: the summary for the synthetic `KNP999999990`.
- `captcha-9C8L2.png`, `captcha-4P99X.png`: pictures the tracker drew, named by their code; TPC
  accepted both readings.
