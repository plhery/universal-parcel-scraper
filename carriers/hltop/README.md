# Hailian Express

Hailian Express (上海海联快递, hltop.com) is a city and domestic express firm in Shanghai. Tracked through the
lookup the form on its tracking page posts to.

## How it works

1. `direct`: one `POST http://47.100.4.126:8090/hltop/search.asp` with the form `id={number}`. The tracking page
   www.hltop.com/seach.asp holds that form, posting to this address; the www host sits behind a YunSuo (云锁)
   script check, and the lookup's own host has none. It answers plain HTTP only, in GB2312, and needs no cookie,
   token or account.
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the budget.

- The page heads its 主单信息 (summary) and 详细追踪信息 (history) tables with the number asked. Both tables empty
  under that number is the tracker's only answer for a waybill it does not know, with no message, so it is read
  as not found only from an HTTP 200 page that echoes the number in both headings. A page without the headings,
  or for another number, is refused, and a summary without rows has no history.
- A browser check is a challenge, and a non-200 reply is a moved route or a request the server refuses.

## Notes

- The history rows are a wall clock with no zone, read on Shanghai's clock with `carrier` as the basis. A clock
  that would date a row after the lookup keeps its wall clock alone.
- Each row starts with a status word, 运送中 or 派送中, then the scan's words with the station unbracketed.
  `statuses.json` lists each row under that word.
- The summary's delivery address, pieces and destination are not read. The delivery row names the courier; that
  clause, and any phone a row gives, is taken out.

## Limitations

- The catalog gives no search page or tracking link: the lookup answers plain HTTP only, and the tracking page
  takes the number through its form.
- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Hailian's waybills seen so far are ten and twelve digits, bare digit runs many carriers' numbers share, so
detection does not name Hailian, and the adapter answers explicit selection for any number of 6 to 30 letters and
digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hltop` tracks the public sample, or the number in `HLTOP_TRACKING_NUMBER`,
and checks an invented waybill, or the one in `HLTOP_UNKNOWN_NUMBER`, reads as not found.
