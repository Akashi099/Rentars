# Availability model

One definition of "is this stay available", used by the calendar, search filters,
quotes and booking creation. Issue #925.

## Which bookings occupy dates

A booking occupies its nights when its status is one of:

| Status | Occupies dates | Notes |
| --- | --- | --- |
| `Pending` | yes | Hold in effect. Stops occupying once the expiry sweep marks it `Expired`. |
| `Confirmed` | yes | |
| `Completed` | yes | Historical; keeps its dates. |
| `Disputed` | yes | Dates stay locked until the dispute is resolved. |
| `Cancelled` | no | Releases dates immediately. |
| `Expired` | no | Abandoned hold. Releases dates. |

The list is defined once, in `src/utils/bookingStatus.ts` (`RESERVING_BOOKING_STATUSES`).
The database exclusion constraint `bookings_no_date_overlap` uses the same list
(migration `00073`).

**Pending holds and timing.** The database cannot depend on the current time, so a
`Pending` hold keeps its nights until the expiry sweep changes it to `Expired`. The
sweep runs on the scheduler. Until it runs, a hold past its `expires_at` still
blocks its nights. Anywhere a host or guest sees "available", that is the state
after the most recent sweep.

## Date boundaries

- A stay is the half-open interval `[check_in, check_out)`. The check-in night is
  occupied. The check-out day is not, so a guest can check in the day another checks out.
- A host block (`availability_ranges` with `is_available = false`) follows the same rule.
- Dates are calendar days in **UTC**. A timestamp with an offset is reduced to its UTC
  day before any comparison (`src/utils/availabilityRange.ts`, `toDay`). Local timezones
  and daylight-saving changes cannot move a booked night.
- Nights are counted by whole UTC days (`nightsBetween`), not elapsed hours.

## Consumers

| Surface | Source of truth |
| --- | --- |
| Booking creation | `create_booking_atomic_v2` (advisory lock + exclusion constraint + block check) |
| Availability check | `checkDateRangeAvailability`, `checkAvailabilityAtomic` |
| Block creation | `blockAvailabilityRange` refuses to overlap any reserving booking |
| Month calendar | `getAvailabilityCalendar` |
| Quote | `getPropertyQuote`. `available` and `unavailable_intervals` come from the nightly breakdown, which covers bookings, host blocks and blocked special events |
| Web calendar | Blocked dates are stepped in UTC days, so they match the UTC keys |

A quote can only say a stay is available if every night in its breakdown is
available, so the quote, the checkout and the booking RPC cannot disagree about one night.
