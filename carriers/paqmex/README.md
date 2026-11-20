# PaqMex

PaqMex, also known as Autolíneas Villarreal, offers domestic parcel and freight delivery in Mexico. The adapter reads its public [Rastreo de guías](https://paqmex.com/rastreo) for a single guide.

## How it works

1. `direct` sends the guide in the `guias` query parameter. The page is public and requires no session.
2. The response returns an identified shipment or echoes the absent guide. The adapter verifies the guide before returning status and dated history.
3. The page may stream parts of the history in separate HTML segments. The parser reconnects the literal segment references and reads one scan per timeline row.

## Limitations

- Scan times are local wall clocks. The portal supplies no UTC offsets.
- The API tracks one guide at a time and reads the public status, scan descriptions, and scan locations. Other page details are outside its scope.
- Select PaqMex explicitly. Its detection entry remains open.

## Testing

Run `npm exec vitest -- run carriers/paqmex/adapter.test.ts`. Set `PAQMEX_NUMBER` and run `npm run test:carriers:live -- carriers/paqmex` to query the native tracker.
