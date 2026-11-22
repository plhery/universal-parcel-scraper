# GF Logistikk

GF Logistikk parcels use enabled universal providers. There is no dedicated adapter.

GF Logistikk is a Norwegian logistics company in Jessheim at Gardermoen, with departments in Agder,
Bergen and Stavanger. It handles air cargo, runs courier cars in Oslo, Kristiansand, Stavanger,
Bergen and Trondheim, and offers distribution, night distribution, technical courier and warehousing.

## Numbers

No public page shows a GF Logistikk number, so there is no rule.

## Why there is no adapter

The tracker is GF's terminal system at `pda.gfedi.net`: the home page's form sends `o=900` and the
number after the prefix `401` as `SP` to `/rcserver`. No public number is known to check its replies
against.

## Links

The tracking form on GF's home page builds the tracker's address, so the catalog's search page is
that home page. The form sends to plain HTTP; the catalog uses HTTPS. Links to `/rcserver` with
`o=900` give the number that follows `401` in `SP`. The canary probes the home page, because the
tracker's replies carry a header name with a space, which Node refuses and browsers read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
