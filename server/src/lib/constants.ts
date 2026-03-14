/** Application-wide constants to avoid magic numbers scattered across routes. */

/** Default hours per working day (AU standard: 7.6h). */
export const DEFAULT_HOURS_PER_DAY = 7.6

/** Working days per week. */
export const DAYS_PER_WEEK = 5

/** JWT token expiry duration. */
export const JWT_EXPIRY = '7d'

/** Password reset token expiry in milliseconds (1 hour). */
export const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000

/** Maximum file upload size in bytes (50 MB). */
export const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024

/** Allowed document formats for generation. */
export const ALLOWED_DOC_FORMATS = ['pdf', 'docx', 'pptx'] as const

/** Resource category display order. */
export const CATEGORY_ORDER = ['ENGINEERING', 'GOVERNANCE', 'PROJECT_MANAGEMENT'] as const

/** Valid allocation modes. */
export const VALID_ALLOCATION_MODES = ['EFFORT', 'TIMELINE', 'FULL_PROJECT'] as const

/** Valid discount types. */
export const VALID_DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT'] as const

/** Valid pricing models for named resources. */
export const VALID_PRICING_MODELS = ['ACTUAL_DAYS', 'PRO_RATA'] as const

// ── Type guard helpers ───────────────────────────────────────
// Eliminates repetitive `(X as readonly string[]).includes(val)` casts in routes.

export function isValidAllocationMode(value: unknown): value is (typeof VALID_ALLOCATION_MODES)[number] {
  return typeof value === 'string' && (VALID_ALLOCATION_MODES as readonly string[]).includes(value)
}

export function isValidDiscountType(value: unknown): value is (typeof VALID_DISCOUNT_TYPES)[number] {
  return typeof value === 'string' && (VALID_DISCOUNT_TYPES as readonly string[]).includes(value)
}

export function isValidPricingModel(value: unknown): value is (typeof VALID_PRICING_MODELS)[number] {
  return typeof value === 'string' && (VALID_PRICING_MODELS as readonly string[]).includes(value)
}

export function isAllowedDocFormat(value: unknown): value is (typeof ALLOWED_DOC_FORMATS)[number] {
  return typeof value === 'string' && (ALLOWED_DOC_FORMATS as readonly string[]).includes(value)
}
