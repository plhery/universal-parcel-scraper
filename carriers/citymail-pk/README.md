# CityMail Pakistan

CityMail Pakistan (CITYMAIL LLC) is a Karachi mail management and cross-border e-commerce company, with a
second head office in Dubai. It delivers Pakistani online shops' orders to the United Arab Emirates, Saudi
Arabia, Oman, Kuwait and Bahrain with cash on delivery, and forwards parcels through its warehouses in the
UAE, Saudi Arabia, the United States and the United Kingdom. Its site is citymail.com.pk. It is not
[CityMail](../citymail/README.md), the Swedish carrier, so its aliases leave out a bare "CityMail".

## How it works

1. `direct`: opens the tracker at `my.citymail.com.pk/track`, which gives a session its cookies and, in
   its head, the token Laravel checks, then posts the number as `cn_no` to
   `my.citymail.com.pk/get-tracking-data-web` with that token in `X-CSRF-TOKEN`, as the page's script
   does. The reply is JSON: status 1 with the parcel as an HTML fragment, or status 0 with "Invalid
   consignment no" for a number it does not know, which is not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more in a new session.

- No login or CAPTCHA. A post without the session's token gets HTTP 419, a challenge rather than
  not found. A post without `X-Requested-With: XMLHttpRequest`, which jQuery sends, gets an empty
  page.
- The fragment's head must name the number asked.

## Notes

- Each tracking row reads "date, time - status - remark". The status is the row's code and sets its
  stage; a status the map does not know goes through the shared wording rules. The remark stays in
  the description, unless it names who took the parcel or holds a phone number.
- Rows keep their wall clock: the tracker gives no zone, and CityMail books parcels in Pakistan and
  the Gulf.
- The head names the customer who booked the parcel, the customer's reference, the booking date and
  the cities it goes from and to. They are left out: the cities come without their country.
- The tracker's page ignores a number in its address, so no link names one.

## Limitations

- No scan location, delivery estimate, weight or proof of delivery.
- No public page lists the tracker's statuses: one missing from [`statuses.json`](statuses.json) is read
  by its wording.

## Numbers

Consignment numbers are nine characters, the length at which the page's script looks one up. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/citymail-pk`

The live test tracks the public sample in `numbers.json` and checks the not-found answer;
`CITYMAIL_PK_TRACKING_NUMBER` tracks another number, and `CITYMAIL_PK_UNKNOWN_NUMBER` another unknown one.
