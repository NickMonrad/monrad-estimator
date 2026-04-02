import { describe, it, expect } from 'vitest'
import { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema } from '../lib/validation.js'
import { sanitizeCsvCell } from '../routes/csv.js'

// Helper that mirrors the exact validation logic in server/src/index.ts
function isJwtSecretInvalid(secret: string): boolean {
  return !secret || secret === 'change-me-in-production' || secret.length < 32
}

// ── 1. JWT startup validation logic ────────────────────────────────────────
describe('JWT startup validation logic', () => {
  it('rejects empty secret', () => {
    expect(isJwtSecretInvalid('')).toBe(true)
  })

  it('rejects the default placeholder secret', () => {
    expect(isJwtSecretInvalid('change-me-in-production')).toBe(true)
  })

  it('rejects secrets shorter than 32 characters', () => {
    expect(isJwtSecretInvalid('too-short')).toBe(true)
  })

  it('accepts a 32-character secret', () => {
    expect(isJwtSecretInvalid('a'.repeat(32))).toBe(false)
  })

  it('accepts a long, secure secret', () => {
    expect(isJwtSecretInvalid('super-secure-random-production-secret-abc123')).toBe(false)
  })
})

// ── 2. Zod schema validation ────────────────────────────────────────────────
describe('loginSchema', () => {
  it('accepts valid credentials', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com', password: 'password123' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'password123' })
    expect(result.success).toBe(false)
  })

  it('rejects password shorter than 8 characters', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com', password: 'short' })
    expect(result.success).toBe(false)
  })

  it('rejects missing email', () => {
    const result = loginSchema.safeParse({ password: 'password123' })
    expect(result.success).toBe(false)
  })

  it('rejects missing password', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com' })
    expect(result.success).toBe(false)
  })
})

describe('registerSchema', () => {
  it('accepts valid registration data', () => {
    const result = registerSchema.safeParse({ email: 'user@example.com', password: 'password123', name: 'Alice' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = registerSchema.safeParse({ email: 'bad', password: 'password123', name: 'Alice' })
    expect(result.success).toBe(false)
  })

  it('rejects empty name', () => {
    const result = registerSchema.safeParse({ email: 'user@example.com', password: 'password123', name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects name over 100 characters', () => {
    const result = registerSchema.safeParse({ email: 'user@example.com', password: 'password123', name: 'a'.repeat(101) })
    expect(result.success).toBe(false)
  })

  it('rejects password shorter than 8 characters', () => {
    const result = registerSchema.safeParse({ email: 'user@example.com', password: 'abc', name: 'Alice' })
    expect(result.success).toBe(false)
  })
})

describe('forgotPasswordSchema', () => {
  it('accepts valid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'user@example.com' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'not-an-email' })
    expect(result.success).toBe(false)
  })
})

describe('resetPasswordSchema', () => {
  it('accepts valid token and password', () => {
    const result = resetPasswordSchema.safeParse({ token: 'abc123', password: 'newpassword' })
    expect(result.success).toBe(true)
  })

  it('rejects empty token', () => {
    const result = resetPasswordSchema.safeParse({ token: '', password: 'newpassword' })
    expect(result.success).toBe(false)
  })

  it('rejects password shorter than 8 characters', () => {
    const result = resetPasswordSchema.safeParse({ token: 'abc123', password: 'short' })
    expect(result.success).toBe(false)
  })
})

// ── 3. CSV formula injection sanitizer ─────────────────────────────────────
describe('sanitizeCsvCell', () => {
  it('leaves normal text unchanged', () => {
    expect(sanitizeCsvCell('Hello World')).toBe('Hello World')
  })

  it('leaves empty string unchanged', () => {
    expect(sanitizeCsvCell('')).toBe('')
  })

  it('prefixes = to prevent formula injection', () => {
    expect(sanitizeCsvCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)")
  })

  it('prefixes + to prevent formula injection', () => {
    expect(sanitizeCsvCell('+cmd|calc')).toBe("'+cmd|calc")
  })

  it('prefixes - to prevent formula injection', () => {
    expect(sanitizeCsvCell('-1+2')).toBe("'-1+2")
  })

  it('prefixes @ to prevent formula injection', () => {
    expect(sanitizeCsvCell('@SUM')).toBe("'@SUM")
  })

  it('prefixes tab character to prevent formula injection', () => {
    expect(sanitizeCsvCell('\tcmd')).toBe("'\tcmd")
  })

  it('prefixes carriage return to prevent formula injection', () => {
    expect(sanitizeCsvCell('\rcmd')).toBe("'\rcmd")
  })

  it('does not prefix numbers that start with digits', () => {
    expect(sanitizeCsvCell('123')).toBe('123')
  })

  it('does not prefix text starting with a letter', () => {
    expect(sanitizeCsvCell('Developer')).toBe('Developer')
  })

  it('handles already-prefixed single-quote correctly', () => {
    // A value starting with ' is safe; but our regex doesn't match it, so it stays as-is
    expect(sanitizeCsvCell("'normal")).toBe("'normal")
  })
})

// ── 4. NaN from parseInt fix ────────────────────────────────────────────────
describe('NaN from parseInt fix', () => {
  it('parseInt("abc") ?? 0 returns NaN (bug)', () => {
    // NaN ?? 0 returns NaN because NaN is not null/undefined
    const result = parseInt('abc') ?? 0
    expect(Number.isNaN(result)).toBe(true)
  })

  it('parseInt("abc") || 0 returns 0 (fix)', () => {
    // NaN || 0 returns 0 because NaN is falsy
    const result = parseInt('abc') || 0
    expect(result).toBe(0)
  })

  it('parseInt("5") || 0 returns 5 (valid input preserved)', () => {
    const result = parseInt('5') || 0
    expect(result).toBe(5)
  })

  it('parseInt("0") || 0 returns 0 (note: falsy but acceptable for weeks)', () => {
    // This is the known edge case: parseInt("0") = 0, 0 || 0 = 0 — still correct
    const result = parseInt('0') || 0
    expect(result).toBe(0)
  })

  it('parseInt("3") ?? 0 returns 3 (valid input still works with ??)', () => {
    const result = parseInt('3') ?? 0
    expect(result).toBe(3)
  })
})
