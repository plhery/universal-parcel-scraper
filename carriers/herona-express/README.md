# Herona Express

Select Herona Express to track an Indonesian rail or road shipment. The public tracking form
issues a guest session and a form token. The adapter uses them for one lookup of the whole
shipment number. The reply contains that lookup's scans without repeating the number.

Scan clocks are kept as local time. The adapter uses the scan codes it has seen and leaves
sender and recipient details outside the result.

Shipment numbers of TSMA and eight digits get rule `herona-express-1`, which suggests Herona
Express. Its five-digit numbers have a shape other carriers share, so nothing suggests it for
them.

Set `HERONA_EXPRESS_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/herona-express`.
