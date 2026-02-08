import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

type Theme = 'light' | 'dark'

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void } | null>(null)

const STORAGE_KEY = 'is-it-up-theme'

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

// Always start from system; only use stored value if user explicitly toggled (so system theme "works")
function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  return getSystemTheme()
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Keep in sync with system preference (and apply on mount in case it changed)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const applySystem = () => setTheme(mq.matches ? 'light' : 'dark')
    applySystem()
    mq.addEventListener('change', applySystem)
    return () => mq.removeEventListener('change', applySystem)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark'
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
