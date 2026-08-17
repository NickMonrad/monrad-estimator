/** Round to at most 2 decimal places, eliminating IEEE 754 float noise. */
export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Calculate task duration in days from effort hours, rounded to 2dp. */
export const calcDurationDays = (hoursEffort: number, hoursPerDay: number): number =>
  round2(hoursEffort / hoursPerDay)

/** Calculate authoritative delivery effort in person-days. */
export const effortDays = (hoursEffort: number, hoursPerDay: number): number =>
  hoursEffort / hoursPerDay

/** Calculate elapsed scheduling duration, honouring a positive task override. */
export const scheduleDurationDays = (
  durationDays: number | null | undefined,
  hoursEffort: number,
  hoursPerDay: number,
): number =>
  durationDays && durationDays > 0 ? durationDays : effortDays(hoursEffort, hoursPerDay)

/** Calculate elapsed task days without dividing an explicit duration override by headcount. */
export const scheduleDurationDaysAtCount = (
  durationDays: number | null | undefined,
  hoursEffort: number,
  hoursPerDay: number,
  resourceCount: number,
): number =>
  durationDays && durationDays > 0
    ? durationDays
    : effortDays(hoursEffort, hoursPerDay) / Math.max(1, resourceCount)