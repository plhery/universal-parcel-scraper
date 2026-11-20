# VNPost

Vietnam Post (VNPost) items are read from the tracker on [vnpost.vn](https://vnpost.vn/vi/ca-nhan/chuyen-phat/chuyen-phat-trong-nuoc),
past its picture captcha.

## Numbers

VNPost numbers domestic and international items alike with UPU S10 numbers ending `VN`, as
lookups archived from VNPost's tracking page show. Postal detection handles them, so VNPost
has no rule of its own.

## Links

VNPost's former tracking page put the number in the path after `/dinh-vi/buu-pham/key/`, and
the library reads it from such addresses. The current form asks for a captcha, so the library
builds no address.

## Retrieval

The tracker opens a Laravel session, gets a picture address from `/handle-captcha/refresh-captcha`,
then sends the whole number and the picture's answer to `/postcode/thong-tin` as `post_code` and
`captcha`. The picture is a four-character `mews/captcha` JPEG. The answer is case-sensitive, and
the service checks it before it looks the number up: a wrong one gets HTTP 422 with
`errors.captcha`, "Captcha không đúng hoặc đã hết hạn".

The adapter reads each picture with its own [model](model/README.md), trained on pictures drawn
the way the tracker draws them, and takes up to five pictures in one session. An accepted answer
for a number the tracker does not know gets HTTP 422 "Mã bưu gửi không đúng!", read as not found.

The reply holds the item in `info`, its scans oldest first in `locate` and its delivery attempts in
`delivery`. Each scan states its clock with Vietnam's offset, a code (`KT1` posting, `KT5`
delivery) and a wording that ends with its office in brackets; the office becomes the scan's
place and the office's coordinates its point. `KT18`, the routing written in the second of the
hand-over to the postman, keeps the stage before it. The delivery rows repeat the delivery scans
with the recipient's name and are not read. A reference to a batch of items (`LO_GUI` 1) is
answered as indeterminate.

## Other entries

The international tracker on `ipostal.vnpost.vn` posts the numbers to `/api/v1/tra-cuu-buu-gui`
with a reCAPTCHA v2 checkbox token and, without one, answers "Vui lòng xác nhận captcha."

The My Vietnam Post Plus Android app (`vn.vnpost.myvnp`) and its web portal `my.vnpost.vn` are
for senders with an account. Their order search and item history need a signed-in session;
without one the app only looks up fees and post offices.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/vnpost/adapter.live.test.ts
```

The live test tracks the public sample in `numbers.json`; `VNPOST_TRACKING_NUMBER` tracks another
item.
