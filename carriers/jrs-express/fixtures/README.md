# Fixtures

Replies of JRS Express's `GET jrs-core-api.azurewebsites.net/api/Tracking/v1/track-airbill?airbill={airbill}-{branch}`.

- `delivered.json`: the reply for the public sample in [`numbers.json`](../numbers.json), a parcel accepted at a
  Muntinlupa branch, sent through the head office and released at the San Mateo, Isabela branch, with the name of
  the person it was released to replaced by a placeholder.
- `not-found.json`: the empty list the API gives a synthetic reference it holds nothing for.
