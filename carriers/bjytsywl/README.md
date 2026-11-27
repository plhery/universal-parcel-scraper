# Yuantongshengyuan Logistics

Yuantongshengyuan Logistics (远通盛源物流, 北京远通盛源物流有限公司) is a Beijing warehousing, sorting and
transport firm that carries parcels between Chinese cities through its own sorting centres. Its site is
bjytsywl.com. Tracked through the tracking page on that site.

## How it works

1. `direct`: one `POST http://www.bjytsywl.com/wuliuinfo.html` with the form `g=1&cnum={number}`, as the
   page's own form sends it. It needs no cookie, token, account or browser. The site answers plain HTTP only:
   its HTTPS certificate is another host's. The reply is the HTML page, with the number in a tab
   (`li#cnum_1`) over its rows (`ul#ul_1`), each `<p><span>clock</span><i>wording</i></p>`, oldest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The page's tab must hold the whole number asked; a page for another number is not an answer.
- `查询的单号不存在，请重新输入` under that tab, with no row, is the page's answer for a number the firm holds
  nothing under, which is not found. A tab with neither rows nor that answer is a changed page; HTML without
  the tab is a browser check or a changed page; a non-200 reply is a moved page.
- The form takes two numbers split by `;`, so the adapter refuses anything but letters and digits.
- The site shows ThinkPHP's 跳转提示 notice when it reads no number from the form: inconclusive. When its
  PHP fails, every page is PHP's `Fatal error` line with HTTP 200, which is a transport failure.
- No tracking link: the page answers a form post only, over plain HTTP, so the catalog links neither it nor a
  search page.

## Notes

- Clocks are wall clocks to the minute with no zone. The firm is in Beijing and its rows are its sorting
  centres' in China, so each row is dated on China's clock with `carrier` as the basis and keeps its wall
  clock. A clock that would date a row after the lookup leaves it its wall clock alone.
- Rows have no code; `statuses.json` records each wording seen, and the status map reads the rows that name
  sorting centres in 【】 by their pattern, whichever centres they name.
- A row names the collector by role (收件员), with their name when it gives one. The adapter takes a role
  word and the name after it out of the wording, and any phone number with its label. A signature by the
  sender stays, since it names no one and reads as the return. A row left with nothing is dropped.
- Places stay in the wording: `location` comes back empty.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

The public sample is twelve digits, a shape many carriers print, so detection does not name the firm for it
(see `core/detection/gaps.json`). The adapter answers explicit selection of any number of 6 to 30 letters
and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/bjytsywl` tracks the public sample, or the number in
`BJYTSYWL_TRACKING_NUMBER`, and checks an invented number, or the one in `BJYTSYWL_UNKNOWN_NUMBER`, reads as
not found.
