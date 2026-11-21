# Fixtures

Replies from Milaha's tracker for the public sample `MILCN1HMD011302` in `numbers.json`, cut to
the parts the parser reads.

- `details-MILCN1HMD011302.html`: the booking and its container, from `TrackingDetails.do`,
  without the page's styles, disclaimer and mail form.
- `moves-QNLU8004000.html`: that container's moves, from `ecomAjax?type=containermovement`, whole.
- `not-found.html`: the same part of the reply for an invented number the tracker holds nothing for.

The tests add a synthetic second container, `QNLU8004001`, whose check digit does not match.
