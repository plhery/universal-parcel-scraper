# Fixtures

Replies of Emirates Courier Express's
`GET api.emiratescx.com/consumer/api/Tracking/v3/EcomTracking/{number}/en-US/view-details`.

- `delivered.json`: the reply for the public sample in [`numbers.json`](../numbers.json), as the API
  gave it: a parcel from the United Kingdom delivered in Riyadh after a refusal. It holds no name,
  phone or street.
- `not-found.json`: the reply for a synthetic twelve-digit number the tracker does not know.
