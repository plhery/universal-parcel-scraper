# Juxi Express

Juxi Express parcels use enabled universal providers. There is no dedicated adapter.

Juxi Express is 上海驹隙国际物流有限公司 (驹隙物流), a Shanghai cross-border forwarder whose site
is juxiex.com, with express and postal small-parcel lines. Universal providers name it SHJX.

## Numbers

Its waybills are JXC, two letters, ten digits and YQ. Forwarders on the Hualei (华磊) platform
end their waybills with YQ and open them with their own code, as [GZYL](../gzyl/README.md) does,
and Juxi Express's old tracker ran on that platform. A sample on ParcelPanel's Juxi Express page
and parcels a universal provider files under SHJX share the layout, and no other carrier's rule
takes it, so `juxi-express-1` has high confidence.

## Links

No tracking page of the carrier remains, so no link opens one parcel.

## Why there is no adapter

The site's tracking and login links opened a Hualei tracker on a bare address, and later on two
others. The site has commented the last two out, none of the three answers, Hualei's own tracker
does not hold Juxi Express waybills, and the service terms send customers to 17TRACK. So Juxi
Express stays on universal providers.

ParcelsApp and 17TRACK answer its parcels, so its demand needs no adapter until Juxi Express publishes a tracker of its own.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
