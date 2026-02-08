import { useState, useEffect } from 'react'
import { useTheme } from './theme'
import { useTranslations } from './i18n'
import './App.css'
import { fetchState, fetchHistory, fetchLastChange } from './api'
import type { State, History, LastChange } from './api'
import { StateCard } from './StateCard'
import { HistoryChart } from './HistoryChart'
import { LastChangeCard } from './LastChangeCard'

const REFRESH_MS = 30_000
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? ''
const GITHUB_REPO_URL = import.meta.env.VITE_GITHUB_REPO_URL ?? ''

function App() {
  const { theme, toggleTheme } = useTheme()
  const { t } = useTranslations()
  const [state, setState] = useState<State | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [lastChange, setLastChange] = useState<LastChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [historyHours, setHistoryHours] = useState(24)
  const [contactsOpen, setContactsOpen] = useState(false)

  const load = async () => {
    setError(null)
    try {
      const [stateRes, historyRes, lastRes] = await Promise.all([
        fetchState(),
        fetchHistory(historyHours),
        fetchLastChange(),
      ])
      setState(stateRes)
      setHistory(historyRes)
      setLastChange(lastRes)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error.failed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [historyHours])

  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [historyHours])

  return (
    <div className="app">
      <header className="header">
        <h1>{t('app.title')}</h1>
        <p className="subtitle">{t('app.subtitle')}</p>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === 'dark' ? t('theme.light') : t('theme.dark')}
          aria-label={theme === 'dark' ? t('theme.light') : t('theme.dark')}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      {loading && !state && (
        <div className="loading">{t('loading')}</div>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {state && (
        <>
          <StateCard state={state} />
          <LastChangeCard lastChange={lastChange} />
          <section className="chart-section">
            <div className="chart-header">
              <h2>{t('history.title')}</h2>
              <select
                value={historyHours}
                onChange={(e) => setHistoryHours(Number(e.target.value))}
                className="hours-select"
              >
                <option value={6}>{t('history.hours6')}</option>
                <option value={12}>{t('history.hours12')}</option>
                <option value={24}>{t('history.hours24')}</option>
                <option value={48}>{t('history.hours48')}</option>
                <option value={168}>{t('history.days7')}</option>
              </select>
            </div>
            <HistoryChart history={history} currentState={state?.state} />
          </section>
        </>
      )}

      <footer className="footer">
        <p>{t('footer.source')}</p>
        {GITHUB_REPO_URL && (
          <p className="footer-link">
            <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="footer-github">
              <span className="footer-github-icon" aria-hidden>
                <svg viewBox="0 0 24 24" fill="currentColor" width="1.1em" height="1.1em">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </span>
              {t('footer.github')}
            </a>
          </p>
        )}
        {CONTACT_EMAIL && (
          <details
            className="contacts-spoiler"
            open={contactsOpen}
            onToggle={(e) => setContactsOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="contacts-summary">
              {t('contacts.title')}
            </summary>
            <div className="contacts-content">
              <p className="contacts-text">{t('contacts.text')}</p>
              <a href={`mailto:${CONTACT_EMAIL}`} className="contacts-email">
                {CONTACT_EMAIL}
              </a>
            </div>
          </details>
        )}
      </footer>
    </div>
  )
}

export default App
