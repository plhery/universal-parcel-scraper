# Foshan Qianhe

Tracks shipments of Foshan Qianhe (佛山乾和国际供应链有限公司, FSQH), a Foshan forwarder, on its
lines to the United States and Britain.

## How it works

Foshan Qianhe's own tenant of the Hualei (华磊) platform answers at
`www.fsqh.hailei2018.com:8082`, over plain HTTP, the tracker its listings on ParcelsApp,
TrackingMore and Track123 name. The adapter is the platform's ([hualei.ts](../gzyl/hualei.ts))
with this carrier's host, clocks and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says Foshan Qianhe holds the number.

## Notes

- Rows in China, placed in Chinese, at `CN` or nowhere, or worded in Chinese, are read on Beijing's
  clock. The rows the line copies from abroad, an airport, warehouse or hub named in English, keep
  their place's wall clock, and GOFO's label is read on Pacific time, as on other lines into the
  United States.
- A record holds the delivery carrier's number in its transfer field without naming a channel:
  GOFO's on the line to the United States, Royal Mail's on the line to Britain. Each is named only
  when its own rule claims the number whole.
- The flight row names the expected landing day, month first ("航班起飞，预计航班落地时间(11.22)");
  the adapter shows it in English with that day.

## Numbers

Foshan Qianhe's numbers have `QH`, twelve digits and `FS`. [DHLink](../dhlink/README.md) carries
some of them on its own lines and then knows them too, so both rules are low; Foshan Qianhe's,
which knows them all, is preferred. No public sample is known; the sample is made up in the shape
of parcels the app tracked.

## Links

The tracker is plain HTTP only, so the catalog links no page of it. The canary takes HTTPS only,
so it checks 17TRACK.

## Testing

Set `FSQH_TRACKING_NUMBER` (and `FSQH_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/fsqh`.
