Replies of `POST http://www.honamlogis.co.kr/tracking_number.php`. `delivered.json` and
`listed-without-events.json` are the replies to two public samples in
[`numbers.json`](../numbers.json), re-indented. In both, the seven customer fields `S_CUST_NM`,
`S_TEL_NO`, `R_CUST_NM`, `R_TEL_NO`, `R_HP_NO`, `R_ZIP_CD` and `R_ZIP_ADDR` are redacted as
`[redacted: N chars]`, or were empty; keep them redacted. The branches' mobile numbers are
replaced with synthetic `0100000000…` ones. Every other value is as the tracker sent it, including
the scans' users, which its page shows.
`not-found.json` is the reply, byte for byte, to a synthetic number the tracker does not know.
The tests derive their other replies from these.
