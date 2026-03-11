import nodemailer from 'nodemailer'

interface SendEmailOptions {
  to: string
  subject: string
  html: string
}

export async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<void> {
  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT ?? '587')
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.SMTP_FROM ?? 'Monrad Estimator <noreply@monrad.app>'

  if (!host || !user || !pass) {
    // Dev mode: log to console instead of sending
    console.log('\n📧 [DEV EMAIL — not sent]')
    console.log(`  To: ${to}`)
    console.log(`  Subject: ${subject}`)
    console.log(`  Body: ${html.replace(/<[^>]+>/g, ' ').trim().substring(0, 300)}`)
    console.log()
    return
  }

  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })
  await transporter.sendMail({ from, to, subject, html })
}
