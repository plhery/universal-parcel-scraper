# Fixtures

Replies of the Mendrix tracking app's API at `emens.mendrix.cloud/WorldLink/TrackAndTrace/v1`.

- `milestones-delivered.json`: the `/milestones` reply for the public sample in
  [`numbers.json`](../numbers.json), a delivered order, with the signee's name and the signature
  image replaced by placeholders.
- `traces-empty.json`: the `/traces` reply for the same order, which holds no scans.
- `not-found.json`: the `/address` reply, with HTTP 400, for an invented code and order number.
- `address.json`: an `/address` reply in the shape the app returns, with placeholder values in place
  of the delivery address.
