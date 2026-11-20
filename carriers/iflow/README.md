# iFLOW

iFLOW parcels use enabled universal providers. There is no dedicated adapter.

iFLOW is an Argentine logistics operator that runs warehouses and supply chains for its clients and
delivers their online orders.

## Numbers

Its tracker takes the number in the order's confirmation email. Its example starts with OR. A
published tracker result shows TRI and thirteen digits, which rule `iflow-1` suggests iFLOW for.

## Guest retrieval

The [web client](https://tracking.iflow21.com/) resolves a parcel code through
`api-btp.iflow21.com/tracking/order/search/{code}`, then reads
`/tracking/order/{tracking_id}` with the returned identifier. Its “not yet trackable”
notice also covers failed API requests.

## Links

`tracking.iflow21.com/#/tracking/code/<number>` looks one number up, and the library reads the
number from that address. The tracker's `/tracking/<id>` pages use an internal id instead.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
