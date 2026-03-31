import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useEffect } from 'react'

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
}

export default function RichTextEditor({ value, onChange, placeholder, className }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
  })

  // Sync external value changes (e.g. when form is reset)
  useEffect(() => {
    if (editor && editor.getHTML() !== value) {
      editor.commands.setContent(value)
    }
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`rich-text-editor border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-700 ${className ?? ''}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 rounded-t">
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
          className={`px-2 py-0.5 text-xs rounded font-bold ${editor?.isActive('bold') ? 'bg-lab3-navy text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
        >B</button>
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleItalic().run() }}
          className={`px-2 py-0.5 text-xs rounded italic ${editor?.isActive('italic') ? 'bg-lab3-navy text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
        >I</button>
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleBulletList().run() }}
          className={`px-2 py-0.5 text-xs rounded ${editor?.isActive('bulletList') ? 'bg-lab3-navy text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
        >• List</button>
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); editor?.chain().focus().toggleOrderedList().run() }}
          className={`px-2 py-0.5 text-xs rounded ${editor?.isActive('orderedList') ? 'bg-lab3-navy text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
        >1. List</button>
      </div>
      {/* Editor content */}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none px-3 py-2 text-sm text-gray-900 dark:text-white min-h-[60px] focus-within:outline-none"
      />
    </div>
  )
}
