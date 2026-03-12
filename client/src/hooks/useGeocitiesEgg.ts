import { useState, useRef, useEffect } from 'react'

const GEOCITIES_CSS = `
  * { font-family: 'Comic Sans MS', cursive, sans-serif !important; cursor: crosshair !important; }
  body {
    background: repeating-linear-gradient(
      45deg,
      #ff00ff,
      #ffff00 10px,
      #00ffff 20px
    ) !important;
  }
  h1, h2, h3, h4, h5, h6 {
    text-shadow: 2px 2px 0 #ff00ff, 4px 4px 0 #ffff00, 6px 6px 0 #00ffff !important;
    animation: geocities-rainbow 0.5s infinite !important;
  }
  @keyframes geocities-rainbow {
    0%   { color: #ff0000; }
    16%  { color: #ff7700; }
    33%  { color: #ffff00; }
    50%  { color: #00ff00; }
    66%  { color: #0000ff; }
    83%  { color: #8b00ff; }
    100% { color: #ff0000; }
  }
  button, a {
    border: 3px ridge #ff00ff !important;
    animation: none !important;
  }
  .bg-lab3-navy, [class*="bg-lab3"] {
    background: linear-gradient(135deg, #ff00ff, #ffff00) !important;
  }
`

const MARQUEE_ID = 'geocities-marquee'
const STYLE_ID = 'geocities-theme'

function injectGeocities() {
  // Style tag
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = GEOCITIES_CSS
  document.head.appendChild(style)

  // Marquee element at the top of body
  const marquee = document.createElement('marquee')
  marquee.id = MARQUEE_ID
  marquee.setAttribute('behavior', 'scroll')
  marquee.setAttribute('direction', 'left')
  marquee.setAttribute('scrollamount', '8')
  marquee.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;background:#000;color:#ff0;' +
    'font-size:18px;font-family:Comic Sans MS,cursive;padding:4px 0;'
  marquee.textContent =
    '🌟 WELCOME TO MONRAD ESTIMATOR 🌟 BEST VIEWED IN NETSCAPE NAVIGATOR 🌟 ' +
    'UNDER CONSTRUCTION 🚧 HIT COUNTER: 1,337 🌟 '
  document.body.prepend(marquee)
}

function removeGeocities() {
  document.getElementById(STYLE_ID)?.remove()
  document.getElementById(MARQUEE_ID)?.remove()
}

/**
 * Geocities easter egg hook.
 * Click the logo 3 times within 2 seconds to activate.
 * Click 5 more times to deactivate.
 *
 * Returns { triggerClick, isActive } — wire triggerClick to the logo onClick.
 */
export function useGeocitiesEgg() {
  const [isActive, setIsActive] = useState(false)
  const clicksRef = useRef<number[]>([])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (isActive) removeGeocities()
    }
  }, [isActive])

  function triggerClick() {
    const now = Date.now()
    clicksRef.current.push(now)
    // Keep only clicks within the last 2 seconds
    clicksRef.current = clicksRef.current.filter(t => now - t < 2000)

    if (clicksRef.current.length >= 3) {
      clicksRef.current = []
      setIsActive(prev => {
        if (prev) {
          removeGeocities()
          return false
        } else {
          injectGeocities()
          return true
        }
      })
    }
  }

  return { triggerClick, isActive }
}
