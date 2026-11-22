# PAD Express

Tracks PAD Express (平安达腾飞快递), a Shenzhen and Dongguan express network in southern
China, through the waybill search on its own site.

## How it works

`direct` fetches `https://www.padtf.com/captcha.php` with the tracking page as referrer; the
picture opens the PHP session that holds its code. The shared text model in
`core/transport/text-captcha-worker.mjs` reads its four letters and digits, and the adapter
posts the waybill and the reading to `https://www.padtf.com/express-tracking.html` in the same
session. A wrong reading comes back as the site's "验证码错误或者为空" page, and the adapter
tries a new picture, up to four. A reading that is not four letters or digits is not sent.

The page lists dated rows on China wall clocks. A row has no scan code, so the phrase it
opens with, such as 已揽件 or 快件到达, is kept as its code. Rows give branch and courier phone
numbers, the courier's name and the signatory; the adapter removes them and keeps the branch
names. The bracketed branch is the event's location; for a delivery, the delivering branch.

## Limitations

Waybills are twelve digits, a shape many Chinese carriers share, so the carrier is never
detected and needs explicit selection. The header's origin, destination, pieces and delivery
photo are left out.

## Testing

`PADTF_TRACKING_NUMBER=… PADTF_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/padtf`
