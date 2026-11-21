# EMO Trans

EMO Trans, a freight forwarder headquartered in Garden City, New York, moves air and ocean
freight through its own offices, Germany among them, and partner agents. Its quick track takes a
shipment number, the shipment's S-number or its house bill.

## How it works

1. `direct`: posts the number to `portal.emotrans-global.com/track/quicktrack`, as the page's
   DataTables script does, then reads the page of the shipment the search names,
   `/track/quicktrack/shipment/<id>?search=<number>`, which lists its events. An empty search is
   not found.
2. `retry`: a read that fails to reach the portal, or hangs, is sent once more.

- Neither request needs a session or a check.
- The search must carry DataTables' whole request, its four columns, their sort and paging:
  without them the portal answers HTTP 500 with its error page.
- A missing page or a redirect is a moved portal, not a missing shipment: an unknown number gets
  an empty search, and the shipment's page is the one the search just named.
- The portal speaks the language of its `trackLocale` cookie; the adapter sends English, whose
  labels the parser reads.

## Notes

- The search also matches master bills, containers and other references several shipments share.
  A row counts only when the number is one of its own shipment numbers or its house bill, and the
  page must show that shipment; a master bill names a consolidation, not one shipment.
- The page's last status can be further on than its newest event, as a delivery is, so it sets
  the stage; the newest mapped event does when the last status is unknown.
- Events keep their station's wall clock: the page gives no zone, and a shipment's stations lie in
  several countries. The station is the event's location.
- "Delivery Cartage Advised" tells the delivering trucker the shipment is coming and says nothing
  of where the freight is, so it keeps the stage of the event before.
- The door estimate is the delivery estimate until the shipment is delivered.
- The link `quicktrack?shipment=<number>` fills the search, which opens the shipment's page when
  it finds one shipment.

## Limitations

- No weight, proof of delivery or event offsets. The origin, the ports, the progress bar and the
  emissions estimate are left out.

## Numbers

EMO Trans documents no number shape. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/emo-trans`

The live test tracks the public sample in `numbers.json` and an invented number;
`EMO_TRANS_TRACKING_NUMBER` tracks another number, and `EMO_TRANS_UNKNOWN_NUMBER` checks the
not-found answer with another unknown one.
