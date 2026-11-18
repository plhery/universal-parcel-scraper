# Bigfoot Express Freight

Bigfoot Express Freight is a break-bulk express road freight carrier based in Durban, with depots
across South Africa and deliveries to Botswana, Lesotho, Eswatini, Namibia, Zambia and Zimbabwe. Its
site is bigfootexpress.co.za.

## Numbers

Public examples are nine characters: three letters and six digits, or two letters and seven. Only an
aggregator's examples show them, so there is no rule.

## Retrieval

The guest page loads its tenant identifier from `config/config.json` and requests `Waybill.getEventData` for one waybill. Each visible scan must name that waybill. Clocks retain their local time because the service gives no offsets.

## Testing

`BIGFOOT_EXPRESS_TRACKING_NUMBER=… BIGFOOT_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/bigfoot-express`
