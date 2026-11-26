# SPC Worldwide Express

SPC Worldwide Express (SPC Worldwide Express Sdn Bhd) is a Malaysian courier with its head office in Petaling
Jaya and branches and agents across Peninsular Malaysia, Sabah, Sarawak and Labuan. Its site is
spcworldwidexp.com.

## How it works

1. `direct`: one `GET http://www.spcworldwidexp.com/tracking2.aspx?ref={number}`, the result page the
   tracking form redirects to. It needs no cookie, session, CAPTCHA or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets half of the
   budget, so the retry fits in the rest.

- The site answers plain HTTP only: its HTTPS port does not answer, so the catalog has no portal link and the
  canary watches a general tracker.
- The page prints the number asked as `CN: …`, which must be the whole number asked. A number the tracker
  does not know gets HTTP 200 with that line and `No Record Found!`, read as not found. Any other page without
  a table is a schema error. A redirect or a 404 is a moved route, a firewall page is a challenge and a 429 is
  a rate limit.

## Notes

- Each row is a wall clock to the minute with no zone, a station code and a status code. Malaysia has one
  zone, so consumers date the rows by the catalog's clock. Rows of one minute keep the tracker's numbering.
- Status codes are the tracker's own and stay as the event text. `statuses.json` maps the ones seen;
  `ATTEMPT` codes with an ordinal are failed attempts. Another code has no stage.
- Stations are SPC's branch codes, such as `SPC-KCH` for Kuching, or an airport code alone. They are kept as
  printed: the hub most consignments pass, `SPC-KPG`, is not named on SPC's branch list.

## Limitations

- No instants, expected delivery, recipient, signatory or proof of delivery.
- The page shows no service, origin or destination.

## Numbers

Published consignment numbers are eight digits, and one is ten. The tracker also takes letters. Eight digits
is a common shape, so no detection rule offers SPC.

## Links

The result page opens numbers from its `ref` parameter.

## Testing

`npm run test:carriers:live -- carriers/spc-worldwide-express`, with `SPC_WORLDWIDE_EXPRESS_TRACKING_NUMBER`
and optionally `SPC_WORLDWIDE_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
