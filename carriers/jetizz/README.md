# Jetizz

Jetizz parcels are read from the tracker on [app.jetizz.com](https://app.jetizz.com/gonderi-takip),
past its picture captcha.

Jetizz Hızlı Taşımacılık A.Ş., based in Beykoz, Istanbul, delivers online shops' orders across Turkey. Its site is jetizz.com.

## Numbers

Its waybills are counters of ten digits whose leading digits rise over time, a shape many other
networks print, so there is no rule. The tracker also takes the thirteen-digit number of partner
Aras Kargo for a parcel Aras delivers.

## Links

The tracker has no per-shipment address, so there are no tracking links.

## Retrieval

The tracker page opens an ASP.NET session that holds the code of a BotDetect picture: four capital
letters or digits in a 95×34 JPEG. Without the `AspxAutoDetectCookieSupport` cookie the page
redirects to set it, so the adapter sends it from the start. The answer goes to
`/gonderi-takip/Home/GonderiBilgi` with the whole number and the picture's instance id, and the
reply is an HTML fragment.

Two checks stand behind the picture:

- The form's script types the code with each character's case set by a counter it finds by
  proof of work: the first one from the form's start whose SHA-1 with the instance id matches the
  form's hash. The service refuses the code in any other case. The shared
  [BotDetect helper](../../core/transport/botdetect.ts) finds the counter and sets the case.
- The service refuses an answer sent within a second or so of the picture, so the adapter waits
  2.5 seconds after it.

The adapter reads each picture with the shared text captcha model, keeping only capital letters
and digits, and takes up to five pictures. A reading that is not four characters takes a new
picture rather than a lookup. "Doğrulama kodu hatalı veya boş !" is a refused answer;
"Gönderi bulunamadı!" past an accepted one is not found.

The reply lists Jetizz's movements and, under them, the scans of partner Aras Kargo. Both are
dated by the day alone, oldest first; only a delivery's current status carries its clock. The
movements and the partner's scans are put newest first by the day, Jetizz's above the partner's.
When a movement's place is `ARASKARGO` and the reply holds an Aras number, the result names Aras
and that number as the delivery carrier. Asked by the Aras number, the result gives Jetizz's
waybill as the canonical number. Wordings the tracker shows are mapped in `statuses.json`; partner
scans it does not list there take Aras's stage.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/jetizz/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json`; `JETIZZ_TRACKING_NUMBER` tracks another
shipment.
