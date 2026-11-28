# Nanbei Express

Nanbei Express (南北快运, Anhui Nanbei Express) is a less-than-truckload freight network based in Hefei, with
branches across Anhui and lines to the rest of China. It brands itself with its Yilian (蚁链) logistics platform.
Its site is nbky.com.cn.

## How it works

1. `direct`: one POST of the form field `orderNo` to the Yilian platform's route service,
   `https://tj.yilian56.com.cn/tms-ylpt/open/followUp/findEventRouteByOrderNo`, as the site's home page form
   does. No session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the platform or hangs.

The reply is JSON: `rows`, oldest first, each naming its waybill (`eventNo`), an epoch clock, an event code
(`eventNode`) and its name, the sentence the site shows (`eventLog`) and the branch or sorting centre that
recorded it (`deptName`). A number without records gets `code` 200 and no rows, read as not found. A row
naming another waybill makes the answer indeterminate.

## Notes

- The clocks are instants, given on China's clock.
- The event codes are staged by `statuses.json`; an unknown code falls to the shared wording rules on its
  name, then its sentence.
- The sentence is the description, without the phone numbers the platform writes into station names, the
  trucks' plates, the drivers' names and who signed. The recording branch or sorting centre is the location.
- The site itself is plain HTTP; the route service also answers HTTPS, which the adapter uses.

## Limitations

No delivery estimate, weight, piece count, sender or recipient. The site shows results under its form, so no
portal link is published, and the canary checks Kuaidi100's page for the firm.

The route service belongs to the Yilian platform, and every public row so far is Nanbei's. A waybill another
company keeps on the same platform would come back the same way.

## Numbers

The public example is eleven digits, a shape many carriers share, so there is no detection rule for Nanbei
and no recognition: a lookup asks Nanbei Express only when the user picks it.

## Testing

`npm run test:carriers:live -- carriers/nanbei-express` reads the public sample, or `NANBEI_EXPRESS_TRACKING_NUMBER`.
