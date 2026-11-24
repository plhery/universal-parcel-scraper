# Aquantuo

Aquantuo ships parcels bought or dropped off abroad, in the United States, the United Kingdom,
China and elsewhere, to its offices in Ghana, Nigeria, Kenya and other African countries. Its
tracking page shows a package's steps by tracking or item id. Tracked through that page.

## How it works

1. `direct`: one `GET https://aquantuo.com/track-order?package_id={id}`, the page Aquantuo's
   track form opens.
2. `retry`: one more request when the first fails to reach the site or hangs.
3. `trawl`: Cloudflare answers a direct request with HTTP 403. After that check, the configured
   browser service opens the same address and the adapter reads the page it renders. Definite
   answers, rate limits and malformed replies do not launch a browser.

- An id the site does not hold gets the search box back with the id in it and nothing else.
  A page whose search box holds another id is inconclusive. Some ids of a shape the site does
  not issue get an HTTP 500 page instead, read as an outage.

## Notes

- Each step keeps its name, such as `Sorting Completed`, which [statuses.json](statuses.json)
  stages. The page writes a message under each name when it renders, and rewrites it over time;
  one names the employee who updated the package. Messages are not kept.
- The page gives clocks without a zone, and Aquantuo's offices span several, so steps keep their
  wall clocks as `local_time` alone.
- The expected delivery day is kept until the package is delivered or disposed of.

## Limitations

- No location, weight, recipient or destination: the page names none outside its messages.
- TRAWL is required in practice: the direct request meets Cloudflare's check.
- The id's shapes are unpublished, so no rule claims them. Select Aquantuo or paste its
  tracking link.

## Testing

`npm run test:carriers:live -- carriers/aquantuo`, with `FLARESOLVERR_URL`,
`AQUANTUO_TRACKING_NUMBER` and optionally `AQUANTUO_UNKNOWN_NUMBER` set outside the repository.
