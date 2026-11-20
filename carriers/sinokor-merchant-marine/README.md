# Sinokor Merchant Marine

Select Sinokor Merchant Marine explicitly and enter the complete Sinokor bill of lading number from the [guest tracking page](https://ebiz.sinokor.co.kr/Tracking).

## Retrieval

The adapter checks the booking through the public tracking form and then reads its tracking table. It verifies the returned bill field and any sea waybill reference in the table. It preserves the carrier's actual dated events and their printed local times.

Port departure and arrival count as transit. Sinokor uses the same pickup and return text for different equipment movements at origin and destination, so those scans remain unstaged. Scheduled vessel movements are excluded.

## Testing

`SINOKOR_MERCHANT_MARINE_TRACKING_NUMBER=… SINOKOR_MERCHANT_MARINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sinokor-merchant-marine`
