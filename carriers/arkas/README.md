# Arkas Line

Arkas Line is the Turkish container line of Arkas Container Transport. Tracked through the
shipment tracking page that [its website](https://arkasline.com.tr/en/online-tracking/) frames,
for a container.

## How it works

1. `direct` calls the tracking service through the page's relay,
   `https://webtrackingprodnew.arkasline.com.tr/api/request/Get`, which takes the service's method
   as `controllerMethod` and its parameters as JSON in `prms`:
   - `webtracking/api/shipmenttracking/GetDocumentationAsync` with `{"key":"<container>"}`, the
     page's search, lists the container's documentation;
   - `webtracking/api/shipmenttracking/GetDocumentationHistoryAsync` with `{"documentationId":<id>}`,
     which the page asks when a result is opened, lists its moves.
2. `retry` asks once more when a request did not reach Arkas.

The service sits behind Cloudflare, which lets the plain requests through. No account, cookie,
token or CAPTCHA is needed. The page also offers the moves as an Excel or PDF report; the JSON
history holds the same moves.

## Notes

- Each search row must name the container asked; the moves are then asked by the documentation
  that row gives. An empty list with the service's message "No matching tracking information" is
  a container Arkas does not hold. Any other empty list, a Cloudflare page or a missing address is
  not. A documentation without a move that happened is a container listed without history.
- The search's summary is not read: its last status can name a move that has not happened yet.
- Moves the service only estimates, which the page greys out, are kept as planned steps, not as
  moves.
- Stages follow the wordings, which say whether the container is full or empty, export or import;
  they are in [statuses.json](statuses.json). An empty container returned before it moved is an
  unused one, a gate out of an empty container after it moved is transit, and the empty return
  after the cargo left is the delivery. Moves under an empty booking, in which Arkas repositions
  its own empty container, get no stage.
- Times are wall clocks: the service states no zone. Locations are the terminal or depot and its
  port.
- Vessels, voyages, the final destination, the container's size and type and the reports are not
  read.

## Limitations

- A container lookup returns the container's latest cycle, which may be a later shipment than the
  one asked about.
- Only the container search is supported. The page also searches bookings and bills of lading;
  no public number of those is known.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Arkas' own
containers carry its `ARKU` owner code; leased containers answer too. Detection has no rule. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/arkas`, with `ARKAS_TRACKING_NUMBER` and
`ARKAS_UNKNOWN_NUMBER` set outside the repository.
