import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const templateUpload = multer({
  dest: path.join(__dirname, '../../uploads/templates/'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20mb
  fileFilter: (_req, file, cb) => {
    const allowed = ['.docx', '.pptx']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) cb(null, true)
    else cb(new Error('Only .docx and .pptx files are allowed'))
  },
})
