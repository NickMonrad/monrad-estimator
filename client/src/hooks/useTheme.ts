import { useEffect } from 'react'

/**
 * Initialises the colour theme on app load.
 * Reads 'theme' from localStorage (default: 'light') and applies the 'dark'
 * class to <html> if needed. Call this once in App.tsx.
 */
export function useTheme() {
  useEffect(() => {
    const stored = localStorage.getItem('theme') ?? 'light'
    if (stored === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [])
}
