# Bridge Intl

Bridge Intl (珀斯宏桥国际速递), based in Perth, ships parcels, luggage and furniture between Australia and
China and delivers door to door within Australia. Its site is bri-ems.com.

## Numbers

The query page takes the firm's order numbers, letters and digits. The public sample is two letters, nine
digits and two letters, the shape of a postal item number, so no rule names Bridge Intl and a declared gap
says why. The adapter takes 6 to 30 letters and digits with a digit. The samples and their sources are in
[`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://www.bri-ems.com/getorder.php?q={number}`, the request the query page's script
   sends, without a session or cookie. Its reply is an HTML fragment the page puts in place.
2. `retry`: a read that fails to reach the site, or hangs, is sent once more within the budget. The first
   try gets half of it.

The fragment `暂无记录` (no record yet) is the only not-found answer. An order's fragment repeats the
number in its order line and its table, and the adapter keeps it only for the number asked. A browser
check is a challenge, a 503 maintenance, a redirect or a missing route a moved site, and anything else a
changed reply.

There is no recognition: no detection rule offers Bridge Intl for a number, so preflight never asks it.

## Status

Rows carry Chinese text only, staged by `statuses.json`, else by the shared wording rules. The page hides a
batch code in white text after some rows; the adapter leaves it out. An order without rows stands on its
order line's status.

## Clocks

Rows are dated to the day and keep their day. The table's warehouse time is not read.

## Hand-off

In China the parcel goes on with a domestic courier. The fragment names its number and links Kuaidi100's
page for it; the adapter gives that number, with China as the destination, and names China Post only when
the link names it and China Post's rules take the number.

## Privacy

The recipient's address in the table is never read.

## Limitations

- Rows carry no place and no clock.
- The domestic courier's scans are not read.

## Links

The query page looks numbers up in place, so no address names one.

## Testing

```sh
npm run test:carriers:live -- carriers/bridge-intl
```

It reads the first public sample from `numbers.json`; `BRIDGE_INTL_TRACKING_NUMBER` and
`BRIDGE_INTL_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic unknown number.
