# Choosing a provider

[coverage.json](coverage.json) records the evidence; [COVERAGE.md](COVERAGE.md) renders it.
`universalPlan()` orders eligible providers by the carrier's history tier, prefers HTTP over
browser within a tier, and retains the default order for ties. Inconclusive and empty sources
remain eligible; wrong-carrier replies and refused formats are excluded when another usable
source remains. Extra references inform those tiers without changing the README comparison.

Validated China Post C/L postal numbers prioritize 17TRACK. UPU requires a valid S10 number
and stays last because its exchange-office history is sparse. A provider is called at most
once per lookup, with a bounded budget. All commercial providers require explicit selection
by the consumer; the facade's default is UPU only.

[universalPlan](plan.ts) is browser-safe. Protocol implementations live in each provider folder.
The facade applies the selected provider set; consumers with their own router can use the
same order and the Node primitives. Persistence, affinity, retries between lookups and shared
cooldowns belong to the consumer.
