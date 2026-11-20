# UOF International

UOF International (骏佳国际) carries freight and small parcels from China to Japan and clears them
through Japanese customs.

## Retrieval

The carrier's tracking page calls `oms.uofexp.com/webservice/Service.ashx` for one or more waybills.
The adapter asks for one number and reads the JSONP reply as data. The page computes its request
checksum from the query itself. The adapter requires an exact match with the reply's customs waybill.

The newest scan sets the status ahead of the summary, which can still say in transit after delivery.
Events with no stated offset keep their wall clocks. Customs appointments are listed as plans.
Document inspections keep their wording without setting a stage in the adapter.

## Scope and links

Select UOF International to use the adapter. Its waybill layout is unverified. The carrier's
tracking page opens a number from its `trackNumber` parameter. Only its own lookup history is read.

## Testing

`UOF_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/uof-express`
