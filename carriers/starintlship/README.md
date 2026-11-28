# StarinTlship

StarinTlship parcels use enabled universal providers. There is no dedicated adapter.

StarinTlship (starintlship.top) sells small-parcel, postal and express lines from China; its scans
start in Hong Kong. 17TRACK lists it as StarinTiship.

## Numbers

No public page shows a whole number. A parcel a universal provider filed under the carrier had
`DHHL`, eight digits and `CN`, so a low rule offers the carrier for that shape and leaves the
answer to the providers.

## Why there is no adapter

The site's tracking page opens `trackIndex.htm?documentCode=` on a Hualei (华磊) tracker at
`114.132.229.173:8082`, over plain HTTP, the platform [GZYL's adapter](../gzyl/hualei.ts) reads
for other tenants. That tracker has answered HTTP 502 from its nginx front to every path, or taken
no connection at all from Europe, the Americas or Asia outside mainland China, Hong Kong included,
so no found reply has been seen to build on.

## Links

The tracking page puts the number in its `tracknumbers` parameter and fills its search box from it,
so such links are read. The page opens the tracker only on a click, so no portal link is given.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
