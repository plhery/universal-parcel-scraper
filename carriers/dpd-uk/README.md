# DPD UK

DPD's United Kingdom consumer delivery service. Switzerland, Germany and France
have separate carrier ids. Automatic history uses the universal providers
enabled by the caller.

## How it works

The official consumer page asks for a reference and delivery postcode.
`apis.track.dpd.co.uk/v1/reference` resolves those to a parcel code. The page
then submits a reCAPTCHA token to `/login` before its session reads
`/parcels/{code}` and the event history.

## Notes

- A group-wide DPD guest response does not establish UK coverage.
- The public tracking link prefills the reference; the user supplies the postcode.
- A failed reference/postcode pair does not distinguish an unknown parcel from
  a wrong postcode.

## Limitations

No dedicated adapter is registered. A successful authorized reference/postcode
pair and the CAPTCHA session are required to validate that retrieval path.

## Testing

Provider live-test inputs and commands are documented in the
[provider READMEs](../../providers/README.md).
