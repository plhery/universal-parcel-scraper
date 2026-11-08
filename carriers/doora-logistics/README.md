# Doora Logistics

Doora Logistics parcels use enabled universal providers. There is no dedicated adapter.

DOORA LOGISTICS CO., LTD. (두라로지스틱스), of Seoul, sends international express parcels,
e-commerce orders and general cargo from Korea, with partner networks in countries such as
Myanmar and Cambodia. Its site is doora.co.kr.

## Numbers

Its tracker takes a house air waybill or a reference of up to 20 characters. Doora publishes no
format and no public page shows one of its numbers, so there is no rule.

## Why there is no adapter

Its tracking page on doora.co.kr opens Doora's LMS tracker for the number,
`lms.doora.co.kr/script/users/tracking.php?mode=search&search_no=<number>`, which answers HTML
with the shipper, the consignee and the scans, or "Unregistered or Incorrect Tracking Number". No
public number is known to see a found reply.

## Links

`www.doora.co.kr/?p=43bf98f0-5801-4251-89ff-f22199d58dff&bl=<number>` opens one parcel. The page
id `p` names the tracking page, so the rule needs it. The LMS address above opens one parcel too,
when it carries `mode=search`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
