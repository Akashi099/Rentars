# Pricing model

How a nightly rate, a stay total and a booking's stored amount are computed. Issue #926.
Rule logic lives in `src/utils/pricingRules.ts` (pure, unit-tested). Service wiring is in
`src/services/pricing.service.ts`.

## Per-night rules

For each night in a stay, in UTC calendar days:

1. **Unavailable nights are not priced.** A blocked special event, a host block, or a
   reserving booking (see [availability-model.md](availability-model.md)) makes the night
   unavailable. A block always beats a price.
2. **At most one seasonal rule applies to a night.** Creating a seasonal rule that
   overlaps an existing one is refused (`409 RULE_OVERLAP`, naming the existing rule). If
   overlapping rules exist anyway (data from before this check), the winner is the
   earliest start date, then the lowest id, so the answer is the same on every read.
3. **At most one priced special event applies to a night**, under the same rule. Priced
   events may not overlap each other. Blocked events may overlap anything.
4. **Nightly rate = base × seasonal multiplier × event multiplier**, rounded to cents once
   per night.

## Bounds

- A multiplier must be a finite number in **[0.1, 10]**. NaN and infinities are refused
  at creation (`INVALID_MULTIPLIER`), which the old range check did not catch.
- A nightly rate must be in **[$1, $10,000]**.
- A night outside these bounds is **out of policy**. A quote for a stay with any such night
  is refused (`422 PRICE_OUT_OF_POLICY`, with the night and the rules that set it). Rates are
  never silently clamped. The host preview (`previewPricing`) shows the computed rate and
  flags the night with `out_of_policy: true`.

## Totals

- Totals are sums of whole cents. Nights are not added as floats, so no drift builds up.
- `subtotal` is the base rate × nights. `dynamic_adjustments` is the difference between the
  rule-based total and that subtotal. `platform_fee` is 5% of the rule-based total, rounded
  to the nearest cent. `total` is the rule-based total plus the fee.
- Dates are UTC days, so a timezone or a DST change cannot move or repeat a night.

## Explaining a price

Every available night in a quote carries `applied_rules`: the seasonal and event rules that
set its price, with id, name and multiplier. A host can see which rule affected any date.

## Quote versions and changes

- `pricing_version` is `pv1` (`PRICING_VERSION`). Bump it when the arithmetic changes.
- `pricing_fingerprint` is a hash of the nights this stay depends on: base rate, each night's
  availability and price, and the rules that applied. It changes when any rule that affects
  this stay changes, and not when an unrelated rule changes.
- Signed quote tokens carry the fingerprint as the `qv` claim. Booking creation rejects a
  token whose fingerprint no longer matches (`PRICE_CHANGED`). Tokens issued before `qv`
  existed skip that check.

## What a booking stores

At creation, the accepted quote is written to the booking in the same update as the listing
terms snapshot: `pricing_version` and `pricing_snapshot` (nightly line items with the rules
that set them, and the totals). Migration `00074` makes the snapshot immutable once recorded.
The total charged is the same validated quote total.
