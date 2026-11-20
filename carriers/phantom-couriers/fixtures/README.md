# Fixtures

Replies of Courie's guest query, `POST https://api.courie.ai/graphql`, with the fields the adapter
asks for.

- `delivered.json` is the reply for a public sample in `numbers.json`: created the evening before,
  given to a driver, picked up and delivered in Vancouver a minute apart. The sequence numbers are
  written as integers; the API prints them as floats.
- `not-found.json` is the reply for an order the courier does not hold.
