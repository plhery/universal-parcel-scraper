FROM python:3.12.15-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS zto-ocr
RUN python3 -m venv /opt/zto-ocr \
    && /opt/zto-ocr/bin/pip install --no-cache-dir numpy==2.5.4 pillow==13.0.0 onnxruntime==1.31.0 \
       opencv-python-headless==5.0.0.93 pyyaml==6.0.3 shapely==2.2.0 pyclipper==1.4.0 six==1.17.0 tqdm==4.70.1 \
    && /opt/zto-ocr/bin/pip install --no-cache-dir --no-deps ddddocr==1.6.1 rapidocr-onnxruntime==1.4.4
# The reCAPTCHA picture solver's object detector, YOLOX-M trained on COCO, and its license, by checksum.
ENV FETCH="import hashlib, sys, urllib.request; data = urllib.request.urlopen(sys.argv[1], timeout=300).read(); \
hashlib.sha256(data).hexdigest() == sys.argv[2] or sys.exit('checksum: ' + sys.argv[1]); open(sys.argv[3], 'wb').write(data)"
RUN mkdir /opt/recaptcha-image \
    && python3 -c "$FETCH" https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_m.onnx \
       21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f /opt/recaptcha-image/yolox_m.onnx \
    && python3 -c "$FETCH" https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/0.1.1rc0/LICENSE \
       577c03d505ec80f667ebf96ebd0cc4f6825c817ca1088ee348c48aaabd51bd92 /opt/recaptcha-image/LICENSE

FROM ghcr.io/germondai/trawl:1.12.0@sha256:da3f25e18d6c5884c5db51d7d05c2dc5a197818b25f03d3dfbb8c3994177cf41
LABEL org.opencontainers.image.source="https://github.com/plhery/universal-parcel-scraper" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
# TRAWL's request log includes the page path, where some carriers put the parcel number.
ENV LOG_LEVEL=warn
# The bundled uBlock Origin compiles and updates its filter lists in every browser the pool
# starts, and page requests wait behind it; carrier pages weigh the same with or without it.
ENV BROWSER_BLOCK_ADS=false
COPY --from=zto-ocr /usr/local /usr/local
COPY --from=zto-ocr /opt/zto-ocr /opt/zto-ocr
COPY --from=zto-ocr /opt/recaptcha-image /opt/recaptcha-image
RUN /opt/zto-ocr/bin/python -c 'import ddddocr, rapidocr_onnxruntime, cv2, onnxruntime; onnxruntime.InferenceSession("/opt/recaptcha-image/yolox_m.onnx")'
COPY license.mjs /app/packages/tiers/src/utils/license.mjs
COPY tracking-capture.mjs /app/packages/tiers/src/utils/tracking-capture.mjs
COPY helper-context.mjs /app/packages/tiers/src/utils/helper-context.mjs
COPY kept-files.mjs /app/packages/tiers/src/utils/kept-files.mjs
COPY lbc-browser.mjs /app/packages/tiers/src/utils/lbc-browser.mjs
COPY aeropost-browser.mjs /app/packages/tiers/src/utils/aeropost-browser.mjs
COPY evri-uk-browser.mjs /app/packages/tiers/src/utils/evri-uk-browser.mjs
COPY dpd-uk-browser.mjs /app/packages/tiers/src/utils/dpd-uk-browser.mjs
COPY warmup-peer.mjs /app/packages/tiers/src/utils/warmup-peer.mjs
COPY usps-tracking.mjs /app/packages/tiers/src/utils/usps-tracking.mjs
COPY swiftx-slider.mjs /app/packages/tiers/src/utils/swiftx-slider.mjs
COPY swiftx-slider.py /app/packages/tiers/src/utils/swiftx-slider.py
COPY royal-mail-history.mjs /app/packages/tiers/src/utils/royal-mail-history.mjs
COPY track123-browser.mjs /app/packages/tiers/src/utils/track123-browser.mjs
COPY fedex-session.mjs /app/packages/tiers/src/utils/fedex-session.mjs
COPY australia-post-browser.mjs /app/packages/tiers/src/utils/australia-post-browser.mjs
COPY wanbexpress-browser.mjs /app/packages/tiers/src/utils/wanbexpress-browser.mjs
COPY sicepat-app.mjs /app/packages/tiers/src/utils/sicepat-app.mjs
COPY veho-browser.mjs /app/packages/tiers/src/utils/veho-browser.mjs
COPY xpo-browser.mjs /app/packages/tiers/src/utils/xpo-browser.mjs
COPY magyar-posta-browser.mjs /app/packages/tiers/src/utils/magyar-posta-browser.mjs
COPY magyar-posta-app.mjs /app/packages/tiers/src/utils/magyar-posta-app.mjs
COPY jd-domestic-browser.mjs /app/packages/tiers/src/utils/jd-domestic-browser.mjs
COPY jd-icon.mjs /app/packages/tiers/src/utils/jd-icon.mjs
COPY jd-icon.py /app/packages/tiers/src/utils/jd-icon.py
COPY asendia-browser.mjs /app/packages/tiers/src/utils/asendia-browser.mjs
COPY correos-costa-rica-browser.mjs /app/packages/tiers/src/utils/correos-costa-rica-browser.mjs
COPY pasarex-browser.mjs /app/packages/tiers/src/utils/pasarex-browser.mjs
COPY freight-aero-browser.mjs /app/packages/tiers/src/utils/freight-aero-browser.mjs
COPY kuwait-post-browser.mjs /app/packages/tiers/src/utils/kuwait-post-browser.mjs
COPY correios-browser.mjs /app/packages/tiers/src/utils/correios-browser.mjs
COPY dao-browser.mjs /app/packages/tiers/src/utils/dao-browser.mjs
COPY inpost-uk-browser.mjs /app/packages/tiers/src/utils/inpost-uk-browser.mjs
COPY peddler-browser.mjs /app/packages/tiers/src/utils/peddler-browser.mjs
COPY rohlig-suus-browser.mjs /app/packages/tiers/src/utils/rohlig-suus-browser.mjs
COPY apm-logistics-browser.mjs /app/packages/tiers/src/utils/apm-logistics-browser.mjs
COPY onex-browser.mjs /app/packages/tiers/src/utils/onex-browser.mjs
COPY neighbour-express-browser.mjs /app/packages/tiers/src/utils/neighbour-express-browser.mjs
COPY magic-trans-browser.mjs /app/packages/tiers/src/utils/magic-trans-browser.mjs
COPY gintracom-browser.mjs /app/packages/tiers/src/utils/gintracom-browser.mjs
COPY transglobal-express-browser.mjs /app/packages/tiers/src/utils/transglobal-express-browser.mjs
COPY turkon-line-browser.mjs /app/packages/tiers/src/utils/turkon-line-browser.mjs
COPY hapag-lloyd-browser.mjs /app/packages/tiers/src/utils/hapag-lloyd-browser.mjs
COPY onlog-express-browser.mjs /app/packages/tiers/src/utils/onlog-express-browser.mjs
COPY flash-courier-guest.mjs /app/packages/tiers/src/utils/flash-courier-guest.mjs
COPY flash-courier-guest.py /app/packages/tiers/src/utils/flash-courier-guest.py
COPY paxel-browser.mjs /app/packages/tiers/src/utils/paxel-browser.mjs
COPY viettel-post-browser.mjs /app/packages/tiers/src/utils/viettel-post-browser.mjs
COPY recaptcha-audio.mjs /app/packages/tiers/src/utils/recaptcha-audio.mjs
COPY recaptcha-backoff.mjs /app/packages/tiers/src/utils/recaptcha-backoff.mjs
COPY recaptcha-image.mjs /app/packages/tiers/src/utils/recaptcha-image.mjs
COPY recaptcha-image.py /app/packages/tiers/src/utils/recaptcha-image.py
COPY dhl-poland-native.mjs /app/packages/tiers/src/utils/dhl-poland-native.mjs
COPY dhl-poland-browser.mjs /app/packages/tiers/src/utils/dhl-poland-browser.mjs
COPY track718-juxi.mjs /app/packages/tiers/src/utils/track718-juxi.mjs
COPY ozon-browser.mjs /app/packages/tiers/src/utils/ozon-browser.mjs
COPY dhl-express-browser.mjs /app/packages/tiers/src/utils/dhl-express-browser.mjs
COPY mailamericas-browser.mjs /app/packages/tiers/src/utils/mailamericas-browser.mjs
COPY poste-italiane-browser.mjs /app/packages/tiers/src/utils/poste-italiane-browser.mjs
COPY sf-express-session.mjs /app/packages/tiers/src/utils/sf-express-session.mjs
COPY sf-express-gap.mjs /app/packages/tiers/src/utils/sf-express-gap.mjs
COPY j-and-t-br-browser.mjs /app/packages/tiers/src/utils/j-and-t-br-browser.mjs
COPY j-and-t-br-slider.mjs /app/packages/tiers/src/utils/j-and-t-br-slider.mjs
COPY zto-browser.mjs /app/packages/tiers/src/utils/zto-browser.mjs
COPY zto-slider.mjs /app/packages/tiers/src/utils/zto-slider.mjs
COPY zto-ocr.mjs /app/packages/tiers/src/utils/zto-ocr.mjs
COPY zto-ocr.py /app/packages/tiers/src/utils/zto-ocr.py
COPY china-post-browser.mjs /app/packages/tiers/src/utils/china-post-browser.mjs
COPY china-post-ocr.mjs /app/packages/tiers/src/utils/china-post-ocr.mjs
COPY china-post-ocr.py /app/packages/tiers/src/utils/china-post-ocr.py
COPY huahan-verify.mjs /app/packages/tiers/src/utils/huahan-verify.mjs
COPY site-cookies.mjs /app/packages/tiers/src/utils/site-cookies.mjs
COPY tier-failure-log.mjs /app/apps/api/src/tier-failure-log.mjs
COPY install.mjs /tmp/install-tracking-capture.mjs
RUN bun /tmp/install-tracking-capture.mjs && rm /tmp/install-tracking-capture.mjs
