# Kargolife

Tracks Kargolife's home deliveries in Turkey through the order-number lookup of its own tracker.
Kargolife delivers only the furniture sold by the Modalife, Mobetto and Sandalie brands, much of it
ordered on Trendyol, and its tracker takes the order number the buyer sees there.

## How it works

1. `direct`: the [tracker page](https://kargolife.com/index.php?url=kargolife/main) posts its
   form back to itself with the order number in `numberOfOrder`; the adapter sends that one POST.
   No cookie, token or browser is needed.
2. `retry`: a request that fails to reach the tracker, or hangs, is sent once more.

The reply draws the order's steps as boxes, from the order received to its delivery, with the step
it has reached in orange, and under them the delivery window. The adapter keeps the orange step's
wording as the status and the window as the estimate while the order is on its way. The answer is
a summary without scans.

## Notes

- The page does not repeat the number. The tracker matches the whole number as typed: a part of
  it, or the number with spaces around it, is not found. So the answer is for the number asked.
- The window is written as `28 - 02/06/2025`: the first day's month and year are left out, and a
  first day after the last one is in the month before. A window in another form is named in
  `unread_estimates` rather than guessed.
- A delivered order keeps the window it was planned in; the adapter drops it, since it no longer
  says when the order comes.
- The not-found notice, `Sipariş bulunamadı` in the pink box, is not found. A page without the
  tracking form or without any step, a step in an unknown box, or no orange step is a schema
  error, and a browser check is a challenge.
- Nothing in an order number points to Kargolife: no detection rule claims it, so preflight does
  not ask this adapter.

## Limitations

No step carries a date or a place, so there is no history and no delivery time. The public samples
are all delivered orders, so how the page draws an order on its way, one orange step among the
others, is read from its styles rather than seen in a reply.

## Testing

`npm run test:carriers:live -- carriers/kargolife`
