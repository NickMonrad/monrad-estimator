import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Module-level mock for nodemailer (hoisted before imports) ───────────────
const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn().mockResolvedValue({ accepted: ['to@test.com'] })
  const mockCreateTransport = vi.fn().mockReturnValue({ sendMail: mockSendMail })
  return { mockSendMail, mockCreateTransport }
})

vi.mock('nodemailer', () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}))

// ── Module under test ───────────────────────────────────────────────────────
import { sendEmail } from '../lib/email.js'

describe('sendEmail', () => {
  const OLD_ENV = { ...process.env }

  beforeEach(() => {
    // Isolate env for every test
    process.env = { ...OLD_ENV }
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  // ── Development fallback ───────────────────────────────────────────────

  describe('development fallback', () => {
    it('logs a dev-email message and returns without calling createTransport when all SMTP credentials are absent', async () => {
      delete process.env.SMTP_HOST
      delete process.env.SMTP_USER
      delete process.env.SMTP_PASS

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await sendEmail({ to: 'dev@test.com', subject: 'Hi', html: '<p>body</p>' })

      // Should NOT have created a transport
      expect(mockCreateTransport).not.toHaveBeenCalled()
      // Should have logged the dev banner
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[DEV EMAIL — not sent]'))
      // Should have logged recipient info
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dev@test.com'))

      logSpy.mockRestore()
    })

    it('falls back to dev mode when only SMTP_HOST is set but credentials are missing', async () => {
      process.env.SMTP_HOST = 'smtp.example.com'
      delete process.env.SMTP_USER
      delete process.env.SMTP_PASS

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await sendEmail({ to: 'dev@test.com', subject: 'Hi', html: '<p>body</p>' })

      expect(mockCreateTransport).not.toHaveBeenCalled()
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[DEV EMAIL — not sent]'))

      logSpy.mockRestore()
    })

    it('falls back to dev mode when SMTP_USER is empty string', async () => {
      process.env.SMTP_HOST = 'smtp.example.com'
      process.env.SMTP_USER = ''
      process.env.SMTP_PASS = 'secret'

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await sendEmail({ to: 'dev@test.com', subject: 'Hi', html: '<p>body</p>' })

      expect(mockCreateTransport).not.toHaveBeenCalled()

      logSpy.mockRestore()
    })
  })

  // ── Transport construction ──────────────────────────────────────────────

  describe('createTransport arguments', () => {
    beforeEach(() => {
      process.env.SMTP_HOST = 'smtp.example.com'
      process.env.SMTP_USER = 'user@example.com'
      process.env.SMTP_PASS = 'correct-horse-battery-staple'
    })

    it('passes host, port, username and password correctly', async () => {
      process.env.SMTP_PORT = '587'

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      expect(mockCreateTransport).toHaveBeenCalledTimes(1)
      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: { user: 'user@example.com', pass: 'correct-horse-battery-staple' },
      })
    })

    it('sets secure=true when port is 465', async () => {
      process.env.SMTP_PORT = '465'

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 465, secure: true }),
      )
    })

    it('sets secure=false when port is 587', async () => {
      process.env.SMTP_PORT = '587'

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 587, secure: false }),
      )
    })

    it('defaults to port 587 when SMTP_PORT is not set', async () => {
      delete process.env.SMTP_PORT

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 587, secure: false }),
      )
    })
  })

  // ── Sender (from) field ─────────────────────────────────────────────────

  describe('sender (from) field', () => {
    beforeEach(() => {
      process.env.SMTP_HOST = 'smtp.example.com'
      process.env.SMTP_USER = 'user@example.com'
      process.env.SMTP_PASS = 'secret'
      process.env.SMTP_PORT = '587'
    })

    it('uses SMTP_FROM when configured', async () => {
      process.env.SMTP_FROM = 'Custom Sender <sender@custom.com>'

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'Custom Sender <sender@custom.com>' }),
      )
    })

    it('uses the default sender when SMTP_FROM is not set', async () => {
      delete process.env.SMTP_FROM

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'Monrad Estimator <noreply@monrad.app>' }),
      )
    })
  })

  // ── sendMail payload ────────────────────────────────────────────────────

  describe('sendMail payload', () => {
    beforeEach(() => {
      process.env.SMTP_HOST = 'smtp.example.com'
      process.env.SMTP_USER = 'user@example.com'
      process.env.SMTP_PASS = 'secret'
      process.env.SMTP_PORT = '587'
      process.env.SMTP_FROM = 'sender@example.com'
    })

    it('passes recipient, subject and HTML to sendMail', async () => {
      await sendEmail({ to: 'recipient@test.com', subject: 'Test Subject', html: '<h1>Hello</h1>' })

      expect(mockSendMail).toHaveBeenCalledTimes(1)
      expect(mockSendMail).toHaveBeenCalledWith({
        from: 'sender@example.com',
        to: 'recipient@test.com',
        subject: 'Test Subject',
        html: '<h1>Hello</h1>',
      })
    })
  })

  // ── Error propagation ───────────────────────────────────────────────────

  describe('error propagation', () => {
    beforeEach(() => {
      process.env.SMTP_HOST = 'smtp.example.com'
      process.env.SMTP_USER = 'user@example.com'
      process.env.SMTP_PASS = 'secret'
      process.env.SMTP_PORT = '587'
    })

    it('propagates sendMail failure', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('Connection refused'))

      await expect(sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })).rejects.toThrow('Connection refused')
    })

    it('propagates createTransport failure', async () => {
      mockCreateTransport.mockImplementationOnce(() => {
        throw new Error('Invalid config')
      })

      await expect(sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })).rejects.toThrow('Invalid config')
    })
  })

  // ── Credential safety ───────────────────────────────────────────────────

  describe('credential safety', () => {
    it('does not log SMTP credentials when SMTP is configured', async () => {
      process.env.SMTP_HOST = 'smtp.example.com'
      process.env.SMTP_USER = 'user@example.com'
      process.env.SMTP_PASS = 'super-secret-password'
      process.env.SMTP_PORT = '587'

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

      // The transport path does not call console.log at all
      expect(logSpy).not.toHaveBeenCalled()

      logSpy.mockRestore()
    })

    it('does not log credential values in dev fallback output', async () => {
      delete process.env.SMTP_HOST
      delete process.env.SMTP_USER
      delete process.env.SMTP_PASS

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await sendEmail({ to: 'dev@test.com', subject: 'Hi', html: '<p>body</p>' })

      // Collect all log messages
      const allLogs = logSpy.mock.calls.map((args) => args.join(' ')).join('\n')
      // No SMTP credential values should appear
      expect(allLogs).not.toMatch(/smtp\.example|password|secret/i)
      // Only safe dev-mode markers
      expect(allLogs).toContain('[DEV EMAIL — not sent]')

      logSpy.mockRestore()
    })
  })
})
