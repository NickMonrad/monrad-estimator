/** Round to at most 2 decimal places, eliminating IEEE 754 float noise. */
export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Calculate task duration in days from effort hours, rounded to 2dp. */
export const calcDurationDays = (hoursEffort: number, hoursPerDay: number): number =>
  round2(hoursEffort / hoursPerDay)

/**
 * Get effective days for demand calculation.
 * Falls through to hours/hpd when durationDays is null, undefined, 0, negative, or NaN.
 * This provides defensive hardening against invalid persisted data.
 */
export const effectiveDays = (
  durationDays: number | null | undefined,
  hoursEffort: number,
  hoursPerDay: number,
): number =>
  durationDays && durationDays > 0 ? durationDays : (hoursEffort / hoursPerDay)
