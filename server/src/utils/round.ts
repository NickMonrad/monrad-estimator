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

/** Calculate elapsed days for tasks sharing one resource type. */
export const scheduleDurationDaysAtCount = (
  tasks: ReadonlyArray<{
    durationDays: number | null | undefined
    hoursEffort: number
    resourceType?: { hoursPerDay?: number | null } | null
  }>,
  fallbackHoursPerDay: number,
  resourceCount: number,
): number => {
  const count = Math.max(1, resourceCount)
  let totalEffortDays = 0
  let totalScheduleDays = 0
  let explicitDurationFloor = 0

  for (const task of tasks) {
    const hoursPerDay = task.resourceType?.hoursPerDay ?? fallbackHoursPerDay
    totalEffortDays += effortDays(task.hoursEffort, hoursPerDay)
    totalScheduleDays += scheduleDurationDays(task.durationDays, task.hoursEffort, hoursPerDay)
    if (task.durationDays && task.durationDays > explicitDurationFloor) {
      explicitDurationFloor = task.durationDays
    }
  }

  return Math.max(
    totalEffortDays / count,
    totalScheduleDays / count,
    explicitDurationFloor,
  )
}