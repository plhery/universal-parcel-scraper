# Fixtures

Whole replies of `quicktrack.aspx?p={number}`, kept as served.

- `delivered.html`: the public sample in `numbers.json`, delivered. The answer beside the form
  gives the current status, the PRO number, the pieces and weight, the origin and destination
  cities, and the pickup and delivery days; the box under it is empty.
- `not-found.html`: the reply for a made-up number: "Not found." under the form, which posts back
  to that number, and no answer.

The tests build a shipment on its way from `delivered.html` by changing its status, its delivery
day and the two empty labels between the pickup and delivery days, which the tests fill with an
estimate. That label wording is invented.
