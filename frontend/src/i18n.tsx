import { createContext, useContext, useState, ReactNode } from 'react'

export type Locale = 'en' | 'uk'

const APP_SUBTITLE = import.meta.env.VITE_APP_SUBTITLE || 'Subtitle for status page'

const translations: Record<Locale, Record<string, string>> = {
  en: {
    'app.title': 'Is It Up',
    'app.subtitle': APP_SUBTITLE,
    'theme.light': 'Light mode',
    'theme.dark': 'Dark mode',
    'state.current': 'Current state',
    'state.on': 'On',
    'state.off': 'Off',
    'state.on_history': 'On',
    'state.off_history': 'Off',
    'lastChange.label': 'Last change',
    'lastChange.switchedTo': 'Switched to',
    'lastChange.was': 'Was',
    'lastChange.for': 'for',
    'units.h': 'h',
    'units.m': 'min',
    'history.title': 'History',
    'history.hours6': '6 hours',
    'history.hours12': '12 hours',
    'history.hours24': '24 hours',
    'history.hours48': '48 hours',
    'history.days3': '3 days',
    'history.days7': '7 days',
    'history.empty': 'No history in this range.',
    'footer.source': 'Data from Home Assistant · refreshes every 30s',
    'footer.github': 'Source on GitHub',
    'contacts.title': 'Contact',
    'contacts.text': 'Questions or feedback? Drop me a line:',
    'contacts.open': 'Show contact',
    'contacts.close': 'Hide contact',
    'loading': 'Loading…',
    'error.failed': 'Failed to load data',
    'chart.state': 'State',
    'chart.time': 'Time',
    'stats.title': 'Statistics',
    'stats.availability': 'Availability',
    'stats.offline': 'Total Offline',
    'stats.outages': 'Outages',
    'stats.avg_duration': 'Avg outage',
    'stats.total_online': 'Online',
    'stats.count_plural': '{count} times',
    'stats.count_singular': '1 time',
    'stats.count_none': '0 times',
  },
  uk: {
    'app.title': 'Чи є світло',
    'app.subtitle': APP_SUBTITLE,
    'theme.light': 'Світла тема',
    'theme.dark': 'Темна тема',
    'state.current': 'Поточний стан',
    'state.on': 'Увімкнено',
    'state.off': 'Вимкнено',
    'state.on_history': 'Увімкн.',
    'state.off_history': 'Вимкн.',
    'lastChange.label': 'Остання зміна',
    'lastChange.switchedTo': 'Змінено на',
    'lastChange.was': 'Було',
    'lastChange.for': 'протягом',
    'units.h': 'год',
    'units.m': 'хв',
    'history.title': 'Історія',
    'history.hours6': '6 годин',
    'history.hours12': '12 годин',
    'history.hours24': '24 години',
    'history.hours48': '48 годин',
    'history.days3': '3 дні',
    'history.days7': '7 днів',
    'history.empty': 'Немає даних за обраний період.',
    'footer.source': 'Дані з Home Assistant · оновлення кожні 30 с',
    'footer.github': 'Вихідний код на GitHub',
    'contacts.title': 'Контакт',
    'contacts.text': 'Питання чи пропозиції? Напишіть:',
    'contacts.open': 'Показати контакт',
    'contacts.close': 'Сховати контакт',
    'loading': 'Завантаження…',
    'error.failed': 'Не вдалося завантажити дані',
    'chart.state': 'Стан',
    'chart.time': 'Час',
    'stats.title': 'Статистика',
    'stats.availability': 'Доступність',
    'stats.offline': 'Без світла',
    'stats.outages': 'Вимкнення',
    'stats.avg_duration': 'Сер. вимкнення',
    'stats.total_online': 'Всього зі світлом',
    'stats.count_plural': '{count} разів',
    'stats.count_singular': '1 раз',
    'stats.count_few': '{count} рази',
    'stats.count_none': '0 разів',
  },
}

const STORAGE_KEY = 'is-it-up-locale'

const LanguageContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void } | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as Locale
    if (saved === 'en' || saved === 'uk') return saved

    if (typeof navigator === 'undefined') return 'en'
    const lang = (navigator.language || navigator.languages?.[0] || '').toLowerCase()
    if (lang.startsWith('uk') || lang.startsWith('ru')) return 'uk'
    return 'en'
  })

  const changeLocale = (newLocale: Locale) => {
    setLocale(newLocale)
    localStorage.setItem(STORAGE_KEY, newLocale)
  }

  return (
    <LanguageContext.Provider value={{ locale, setLocale: changeLocale }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useTranslations() {
  const ctx = useContext(LanguageContext)
  if (!ctx) {
    throw new Error('useTranslations must be used within LanguageProvider')
  }
  const { locale, setLocale } = ctx
  const t = (key: string): string => translations[locale][key] ?? translations.en[key] ?? key
  return { t, locale, setLocale }
}
