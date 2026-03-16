import { describe, expect, it } from 'vitest'
import { getProjectCustomerName } from '@/lib/projectCustomer'

describe('getProjectCustomerName', () => {
  it('returns the customer string unchanged', () => {
    expect(getProjectCustomerName('Acme Corp')).toBe('Acme Corp')
  })

  it('returns the customer name from an API customer object', () => {
    expect(getProjectCustomerName({ id: 'cust-1', name: 'Acme Corp' })).toBe('Acme Corp')
  })

  it('returns null when customer is missing', () => {
    expect(getProjectCustomerName(null)).toBeNull()
    expect(getProjectCustomerName(undefined)).toBeNull()
  })
})
