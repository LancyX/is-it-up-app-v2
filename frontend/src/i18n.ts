export type Locale = 'en' | 'uk'

const translations: Record<Locale, Record<string, string>> = {
  en: {
    'app.title': 'Is It Up',
    'app.subtitle': 'м.Вишневе, Сади Вишневі, вул. Машинобудівників',
    'theme.light': 'Light mode',
    'theme.dark': 'Dark mode',
    'state.current': 'Current state',
    'state.on': 'On',
    'state.off': 'Off',
    'state.on_history': 'On',
    'state.off_history': 'Off',
    'lastChange.label': 'Last change',
    'lastChange.switchedTo': 'Switched to',
    'history.title': 'History',
    'history.hours6': '6 hours',
    'history.hours12': '12 hours',
    'history.hours24': '24 hours',
    'history.hours48': '48 hours',
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
  },
  uk: {
    'app.title': 'Чи є світло',
    'app.subtitle': 'м.Вишневе, Сади Вишневі, вул. Машинобудівників',
    'theme.light': 'Світла тема',
    'theme.dark': 'Темна тема',
    'state.current': 'Поточний стан',
    'state.on': 'Увімкнено',
    'state.off': 'Вимкнено',
    'state.on_history': 'On',
    'state.off_history': 'Off',
    'lastChange.label': 'Остання зміна',
    'lastChange.switchedTo': 'Змінено на',
    'history.title': 'Історія',
    'history.hours6': '6 годин',
    'history.hours12': '12 годин',
    'history.hours24': '24 години',
    'history.hours48': '48 годин',
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
  },
}

/** Ukrainian for uk/ru, otherwise English */
export function getLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const lang = (navigator.language || navigator.languages?.[0] || '').toLowerCase()
  if (lang.startsWith('uk') || lang.startsWith('ru')) return 'uk'
  return 'en'
}

export function useTranslations() {
  const locale = getLocale()
  const t = (key: string): string => translations[locale][key] ?? translations.en[key] ?? key
  return { t, locale }
}
