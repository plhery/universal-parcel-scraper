# Fixtures

Replies of `GET https://oa.yue777.com/Weixin/Hg/trace?bill=<number>&callback=ehandle`, saved as served:

- `delivered.txt`: the public sample in [`numbers.json`](../numbers.json), taken in at San
  Diego, flown from Los Angeles, cleared in China and delivered by SF Express. The SF courier's name and
  phone number in its rows are replaced with invented ones.
- `not-found.txt`: the reply for an invented number.

The tests derive their other replies from these, under invented numbers.
