# MAX Pakket

MAX Pakket, in Deventer, collects and delivers big, long and heavy parcels across the
Netherlands for businesses and individuals. Its site is maxpakket.nl.

Its track and trace page runs on the Mendrix transport system's tracking app at
`emens.mendrix.cloud`. The delivery email links to it with the order's Track & Trace code and its
order number: `https://emens.mendrix.cloud/TrackAndTrace/tnt?Tracecode=<code>&OrderId=<order>`. The
app opens an order only with both, or with the code and the delivery address, so the link is an
optional tracking-URL input; without it, enabled universal providers are asked.

## How it works

1. `direct`: reads the tracking app's API at `emens.mendrix.cloud/WorldLink/TrackAndTrace/v1`, as
   its script does:
   - `GET /address?Tracecode=<code>&Orderid=<order>` opens the order and sets the `mxtt_traceinfo`
     session cookie, which names the code, the order number and the client in base64 JSON. The
     cookie must name the link's code and order number and a client; otherwise the answer stays
     open. The address in the reply is never read.
   - `GET /milestones` and `GET /traces` in that session give the order's milestones and its scans.
2. `retry`: a read that fails to reach the API, or hangs, is made once more. The first try gets
   half of the budget.

- No account, token or CAPTCHA.
- A code and order number the app holds no order under get HTTP 400 and "Invalid TraceInfo: unable
  to find traced route (invalid order)", or "(invalid task))" when the code is not the order's,
  read as not found. Another refusal, or any refusal once the order has opened, leaves the answer
  open; a block page is a challenge, a redirect or a 404 a moved API, and a reply of another shape a
  changed one.

## Notes

- The milestones are registered, on its way and delivered, or collected for a collection order.
  The furthest one reached, completed or active, gives the status, worded as the app words it:
  "Aangemeld", "Onderweg", or "Succesvol afgeleverd" and its partial and failed forms.
- The scans, when the order has any, are its history. An order without scans gets two events
  from the summary each milestone repeats: its registration at the order moment, and its completed
  stop at the driver's departure, else the arrival, which is the delivery time of a delivered order.
- The app writes its moments with their offset; a moment without one is kept as a wall clock. Its
  empty moments are in the year one and are ignored.
- An order not yet completed is due in the stop's planned window, else in the window it was booked
  for.
- The signature, the signee's name, the sender, the driver, the goods and the delivery address are
  never read.

## Limitations

- Without the link's order number the code cannot be tracked; the app's other way in needs the
  delivery postcode and house number.
- The scan wordings come from the app's translations; a public order with scans has not been seen
  yet, so unknown wordings are read by the shared wording rules.

## Numbers

Track & Trace codes are MXTT and hexadecimal digits. Every company running Mendrix's tracking app
prints them, so detection has no rule for them. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

The email's link on `emens.mendrix.cloud/TrackAndTrace/tnt` names MAX Pakket and is kept as the
tracking-URL input.

## Testing

`npm run test:carriers:live -- carriers/max-pakket`

The live test tracks the sample in `numbers.json` with its archived link and checks the not-found
answer for an invented code; `MAX_PAKKET_TRACKING_NUMBER` and `MAX_PAKKET_TRACKING_URL` track
another order.
