# ZTO Express

Chinese domestic ZTO parcels use enabled universal providers. There is no dedicated adapter.

## How it works

The official website's `/check` flow posts waybills to `hdgateway.zto.com/batchGetTrace`.
The feed requires a CAPTCHA token; an anonymous request without one returns a verification
request instead of parcel history. A reachable form does not establish automated retrieval.

## Limitations

International ZTO services use separate portals. Domestic number shapes overlap other
carriers and do not establish ZTO ownership.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
