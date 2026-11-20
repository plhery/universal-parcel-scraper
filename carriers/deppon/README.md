# Deppon

Reads Deppon's public tracking gateway through HTTP, including its image-slider verification.

Deppon (德邦) is a Chinese express and freight carrier, now part of JD Logistics. Its tracker
also follows its parcels to Taiwan.

## Retrieval

The [official tracker](https://www.deppon.com/orderTrack) gets a `blockPuzzle` from
`/gwapi/messageService/eco/message/captcha/getCaptchaAction`. The adapter matches the
transparent tile's texture to its slot, submits the native pixel offset to `checkCaptchaAction`
in the page's AES envelope and requires the server's accepted verification before tracking.
Uncertain matches and refused puzzles remain challenges. Each lookup owns its challenge and cookies.

It then posts one whole waybill to `/gwapi/trackService/eco/track/queryNewTrack` with the
single-use verification. The returned `billNo` must match, and `tracks` supplies the history.
Operation types stage known scans; unknown types do not inherit the page's generic transit icon.
Clocks without offsets stay local. Recipient fields and scan contact suffixes are omitted.
Transport diagnostics retain no verification material.

The carrier-linked [Android app](https://sj.qq.com/appdetail/com.deppon.dpapp) bundles the
same tracking gateway and slider endpoints. Recipient details, signatures and courier-location
operations use separate routes and are outside this adapter.

## Limitations

`deppon-dpk` names Deppon for `DPK` and twelve digits, the express waybills a published
enforcement notice and universal providers attribute to its network. Its other waybills are plain
digits that this shape cannot tell apart, so the request builder accepts them without establishing
ownership. There is no cheap recognition, and no account is used. Changed puzzle geometry or weak
texture can prevent a solve; enabled universal providers remain the fallback.

Deppon's Huawei cloud firewall answers HTTP 418 with a block page to addresses outside Greater
China, browsers included, and the adapter reports it as a challenge. Hong Kong and mainland exits
pass, so a consumer routes `www.deppon.com` through one.

## Testing

`npm run test:carriers:live -- carriers/deppon`. Set `DEPPON_TRACKING_NUMBER` for a known
shipment and `DEPPON_UNKNOWN_NUMBER` for an unknown waybill.
