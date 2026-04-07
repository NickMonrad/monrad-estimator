import puppeteer, { Browser } from 'puppeteer'
import sanitizeHtml from 'sanitize-html'

// #177: Singleton browser — avoids 1-3s startup and 100-200MB RAM per request
let browserInstance: Browser | null = null
let activePdfs = 0
const MAX_CONCURRENT = 2

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
  }
  return browserInstance
}

export async function generatePdfFromHtml(html: string): Promise<Buffer> {
  // Simple semaphore — wait if at capacity
  while (activePdfs >= MAX_CONCURRENT) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  activePdfs++
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
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
    await page.setContent(safeHtml, { waitUntil: 'networkidle0', timeout: 30_000 })
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '48px', right: '48px' },
      timeout: 30_000,
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await page.close()
    activePdfs--
  }
}

// Graceful shutdown — close the shared browser when the process exits
process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close()
})
