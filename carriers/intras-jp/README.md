# INTRAS

Select INTRAS to track Korea–Japan parcels by the house bill in the public tracking page.
The adapter checks the page's house bill before using its selected progress milestone,
customs entries and any domestic courier scans.

The customs and domestic tables supply local clocks. The progress milestone can be newer
than the latest dated scan. The page supplies planned sailings separately, and the adapter
omits those plans and customs declaration references.

Set `INTRAS_JP_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/intras-jp`.
