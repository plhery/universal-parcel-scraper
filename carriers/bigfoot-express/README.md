# Bigfoot Express Freight

Bigfoot Express Freight is a break-bulk express road freight carrier based in Durban, with depots
across South Africa and deliveries to Botswana, Lesotho, Eswatini, Namibia, Zambia and Zimbabwe. Its
site is bigfootexpress.co.za.

## Numbers

Public examples are nine characters: three letters and six digits, or two letters and seven. Only an
aggregator's examples show them, so there is no rule.

## Retrieval

The guest page loads its tenant identifier from `config/config.json` and requests `Waybill.getEventData` for one waybill. Each visible scan must name that waybill. Clocks retain their local time because the service gives no offsets.

[ACT Logistics](../act-logistics/README.md), [Intertown Transport](../intertown-transport/README.md) and
[Primetime Express](../primetime-express/README.md) run on the same ParcelPerfect tracker, so the
adapters share `parcelPerfect.ts`. Its wording names the depot, as in "Checked in at Durban
facility"; a scan's stage is read without the depot, and wording no tenant has recorded goes to the
shared rules. The depot captures the consignment and marks it ready for collection after the
driver has collected it, so those scans keep the stage the parcel has. "Dispatched" is a vehicle
leaving: after the parcel is loaded for delivery, it is the delivery round.

`bigfootexpress.pperfect.com/?w=<waybill>` opens one waybill: the page stores the number and moves
to its waybill view, whose address no longer holds it.

## Testing

`BIGFOOT_EXPRESS_TRACKING_NUMBER=… BIGFOOT_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/bigfoot-express`
