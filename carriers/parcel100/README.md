# Parcel100

Parcel100 (Parcel100 B.V.) ships parcels from its warehouses in the Netherlands and Poland to China by
air, clears them through Chinese customs and hands them to a courier in China. Tracked through the
service behind its tracking page at track.parcel100.com.

## How it works

1. `direct`: one `GET https://api.parcel100.com/api/v1/common/parcel/track?numbers[]={number}`, the
   request the tracking page sends. It needs no cookie, token, account or browser. The reply is JSON,
   `{status, code, msg, data}`, with each parcel asked in `data` under its `parcel_number` and its rows
   in `logs`.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- `status` false with `msg` 单号不存在 is the answer for a number the tracker does not know. Any other
  refusal is inconclusive, and a non-200 reply is a moved route. The parcel read must be the whole
  number asked.

## Notes

- Parcel100's own rows carry a status code, staged by `statuses.json`. Code 0 marks a row it relays from
  the courier in China, or a flight row, in that party's words: those are staged by the shared wording
  rules, and their first bracket names the place.
- 派送中 (code 80) comes the second the parcel clears customs and the courier's rows follow for days, so
  it reads as in transit, not as the delivery round. Downloading the label and paying are notices that
  keep the stage before them.
- The reply states no zone, and Parcel100's rows and the relayed rows need not share a clock, so every
  row keeps its wall clock alone.
- The relayed rows give the courier's and the pickup point's phones and sometimes the courier's name.
  A bracket or clause that gives a contact is left out.
- Parcel100 may close a parcel as signed for (签收成功) weeks after the courier's own delivery row.

## Limitations

- No delivery estimate, weight, sender or recipient, and the courier in China is not named as a field.
- The tracking page takes a number typed into its form and has no address for one parcel, so the
  catalog links none.

## Numbers

The public samples are a PK number, a shape other carriers' references share, and Poczta Polska's
number in the UPU S10 layout for a parcel taken in at the Polish warehouse, which detection gives to
the post. No detection rule offers Parcel100 and the adapter answers explicit selection. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/parcel100` tracks Kuaidi100's test number, or the number in
`PARCEL100_TRACKING_NUMBER`, and checks an invented number, or the one in `PARCEL100_UNKNOWN_NUMBER`,
reads as not found.
