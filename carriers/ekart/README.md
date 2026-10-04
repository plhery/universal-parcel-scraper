# Ekart

Tracks Indian ecommerce parcels through Ekart's public tracking website. Bulk freight and LR shipment IDs use a separate service.

The `direct` step opens the tracking page for anonymous session cookies and its CSRF token, then posts the ecommerce tracking ID to the website's JSON feed. Each lookup owns its session, so simultaneous parcels cannot mix tokens.

History retains scan wording, city and epoch timestamps. An empty object or missing history is inconclusive because it does not establish parcel absence. Unknown wording remains visible without an invented milestone.

Live test: `EKART_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/ekart`.
