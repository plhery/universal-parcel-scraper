# IndiGo CarGo

IndiGo CarGo tracks domestic and international air freight carried by IndiGo.

## Retrieval

The adapter obtains fresh state from IndiGo's public SmartKargo form and submits one
master air waybill. It reads the booking, acceptance and movement tables after verifying
the entire returned number. The carrier reports station wall clocks without offsets.

## Limitations

Select IndiGo CarGo and enter the full master air waybill. The public page opens a form
where the airline prefix and serial can be entered manually.

## Testing

`INDIGO_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/indigo-cargo`
