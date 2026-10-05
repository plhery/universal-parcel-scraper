# LBC Express

Tracks twelve-digit Philippine LBC shipments through the public website in a configured local Chromium browser. It opens the tracking form, submits the current anonymous search request, and follows the opaque handle returned by that request. Handles are never constructed or persisted.

A fresh browser context keeps the lookup isolated. The browser completes the website's automatic JavaScript protection; interactive challenges remain failures. The returned form must identify the requested number before any history is projected. Empty history is inconclusive because the website does not explicitly declare shipment absence.

The history supplies calendar dates without scan times. They remain provider text in current-first order, so no update or delivery instant is invented. Exact duplicate rows are removed, and delivered-to names are discarded. The current portal does not expose a verified raw-number permalink.

Requires `TRACKING_CHROMIUM_PATH`; browser-service retrieval, detailed locations, estimates, and pickup points are not implemented. Provide `LBC_TRACKING_NUMBER` outside Git for a positive live lookup.

`npm run test:carriers:live -- carriers/lbc-express`
