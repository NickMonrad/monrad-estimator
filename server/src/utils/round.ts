/** Round to at most 2 decimal places, eliminating IEEE 754 float noise. */
export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Calculate task duration in days from effort hours, rounded to 2dp. */
export const calcDurationDays = (hoursEffort: number, hoursPerDay: number): number =>
  round2(hoursEffort / hoursPerDay)
