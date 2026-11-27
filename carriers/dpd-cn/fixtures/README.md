`not-found.json` is the service's whole reply to the all-zero placeholder number: the envelope with
its `NotFound` row.

`synthetic-delivered.json` is synthetic: no public page shows a DPD China number. It is the
decoded `result` of a reply, built from the row model the tracker's script reads, with the
wordings and places DPD China's replies carry, and invented clocks, master air waybill and number.
It has no `CustomerRef`. Tests wrap it in the envelope.
