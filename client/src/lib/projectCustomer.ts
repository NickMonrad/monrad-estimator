import type { Project, ProjectCustomer } from '../types/backlog'

export function getProjectCustomerName(
  customer: Project['customer'] | ProjectCustomer | undefined,
): string | null {
  if (!customer) return null
  if (typeof customer === 'string') return customer
  return customer.name ?? null
}
