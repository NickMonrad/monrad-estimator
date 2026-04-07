import puppeteer from 'puppeteer'
import sanitizeHtml from 'sanitize-html'

export async function generatePdfFromHtml(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const page = await browser.newPage()
    // #170: sanitize HTML before passing to Puppeteer to prevent SSRF/injection
    const safeHtml = sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['style', 'svg', 'path', 'circle', 'rect', 'line', 'polygon', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        '*': ['class', 'style', 'id'],
        'svg': ['xmlns', 'viewBox', 'width', 'height'],
        'path': ['d', 'fill', 'stroke'],
      },
      allowedSchemes: ['http', 'https', 'data'],
    })
    await page.setContent(safeHtml, { waitUntil: 'networkidle0' })
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '48px', right: '48px' },
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await browser.close()
  }
}
