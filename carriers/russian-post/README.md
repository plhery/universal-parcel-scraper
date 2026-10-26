# Russian Post

Russian Post items use enabled universal providers. There is no dedicated adapter.

## Numbers

Domestic Russian Post numbers are fourteen digits, as users quote them on gdeposylka: the
accepting office's six-digit postcode, seven digits and a GS1 check digit. Fourteen digits are
shared with several carriers. Russian postcodes never start with 8, yet the numbers starting with
80 that users and providers report are Russian Post's, so `russian-post-1` puts Russian Post
first for those when the check digit passes. It stays a suggestion: the other carriers' numbers of
that length are not ruled out. International items use the UPU S10 layout and stay with the
generic postal carrier.

## Why there is no adapter

The tracker at `www.pochta.ru/tracking` and the JSON service it calls answer requests from
networks outside Russia with an HTTP 417 page asking the visitor to turn off a VPN, whether the
client is plain HTTP or a browser. The `passport.pochta.ru` sign-in service sits behind the
same block.

The Pochta Rossii app (`com.octopod.russianpost.client.android`) reads tracking from
`mobileapp.russianpost.ru/mobile-api/method/<version>/`, which does answer from abroad. An
install registers through `auth.signin/prepare` and `auth.signin/complete` with a device token
the app derives from its install id, a random attempt id, the time and a constant every install
shares, and the server issues an access token even when the install reports that Play Integrity
is unavailable. The server's `application.settings` turn anonymous tracking off, though:
`track.item.get` and `track.item.create` answer code 1115, "Requested functionality is not
available for anonymous users", until the install signs in with a Pochta ID account.

The documented SOAP tracking service at `tracking.russianpost.ru/rtm34` answers from abroad but
needs the login and password of a registered account. Older open-source clients called its
account-free predecessor at `voh.russianpost.ru:8080/niips-operationhistory-web/OperationHistory`,
which no longer accepts connections, from inside Russia either. No route reads a number
anonymously from outside Russia, so Russian Post stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
