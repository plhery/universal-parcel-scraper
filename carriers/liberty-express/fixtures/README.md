# Fixtures

Replies of Liberty Express's iQPack tracker, kept as served apart from the anti-forgery token, which is replaced by a
synthetic one.

- `form.html`: the search page `SearchGuide`, whose form carries the token and takes the number.
- `not-found.html`: the search page the form posts back for a made-up receipt: the number in the field and the notice
  that the guide does not exist.
- `ready-for-pickup.html`: the tracking page of the public sample in `numbers.json`: the current status and the
  warehouse receipt above the history, newest first, from the Doral warehouse to a Venezuelan branch.
