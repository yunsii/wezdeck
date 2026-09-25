import { createContext, useContext, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

export const themeBootstrapScript = `(function(){try{var k='wezdeck-theme',m=localStorage.getItem(k);if(m!=='light'&&m!=='dark'&&m!=='system')m='system';var t=m==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;document.documentElement.dataset.theme=t;document.documentElement.dataset.themeMode=m;}catch(e){document.documentElement.dataset.theme='dark';document.documentElement.dataset.themeMode='system';}})()`

function resolveTheme(mode: ThemeMode) {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolveTheme(mode)
  document.documentElement.dataset.themeMode = mode
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'system'
    const bootstrapped = document.documentElement.dataset.themeMode
    if (
      bootstrapped === 'light' ||
      bootstrapped === 'dark' ||
      bootstrapped === 'system'
    )
      return bootstrapped
    const stored = window.localStorage.getItem('wezdeck-theme')
    return stored === 'light' || stored === 'dark' || stored === 'system'
      ? stored
      : 'system'
  })

  useEffect(() => {
    applyTheme(mode)
    window.localStorage.setItem('wezdeck-theme', mode)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => mode === 'system' && applyTheme(mode)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [mode])

  return (
    <ThemeContext.Provider value={{ mode, setMode }}>
      {children}
    </ThemeContext.Provider>
  )
}

const ThemeContext = createContext<{
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
} | null>(null)

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
