# Caifeng Logistics

Caifeng Logistics (彩丰物流, 彩丰物流集团) is a road freight firm based in Chaozhou, Guangdong, with lines between
its Chaoshan branches and the rest of China. Its site is caifengwl.com. Its waybills are on a TMS platform at
tms.gdonetrue.com that keeps each firm in its own database.

## How it works

1. `direct`: one `GET https://tms.gdonetrue.com/weixin/LogisticTrace.ashx?database=ausoft_caifeng&no=…`, the
   lookup the site's tracking page (`list-a1002002.html`) asks for a number of thirteen digits or more. No
   session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the platform or hangs.

A waybill is JSON: the firm's name on the platform (`dbname`), the waybill number, its parties and goods, and
`result`, its rows newest first, each with its waybill, a wall clock, the operation that wrote it (`type`),
the sentence the page shows and the department that recorded it. An unknown number gets the bare text `no`,
read as not found. A reply under another name than 彩丰物流 or about another waybill is indeterminate; the
platform's refusals (a database it has not opened, a request it cannot read) are indeterminate too.

## Notes

- Rows keep their wall clock as `local_time` and are dated on China's clock with `carrier` as the basis.
- The operation is the row's code. The operations in `statuses.json` carry one stage whatever the sentence;
  an unknown one falls to the shared wording rules on the sentence.
- The sentence is the description, without the branch phones, the truck's plate and the driver it names.
  The location is the department that recorded the row, except that an arrival row (车辆已到达…) is placed at
  the branch it names, since the branch the truck left records it.
- The parties, the goods, the piece count and the staff who recorded each row are not read.
- The site's page sends numbers of CF and fourteen more characters to a second lookup on port 8089 of the
  site, which did not answer; such numbers are not taken.

## Limitations

No delivery estimate, weight or proof of delivery. The page shows results under its form, so no portal link
is published, and the canary checks Kuaidi100's page for the firm.

## Numbers

The public example is thirteen digits (a branch code, the day the waybill was written and a serial), a digit
run many carriers' numbers share, so there is no detection rule and no recognition: a lookup asks Caifeng
only when the user picks it.

## Testing

`npm run test:carriers:live -- carriers/caifengwl` reads the public sample, or `CAIFENGWL_TRACKING_NUMBER`.
