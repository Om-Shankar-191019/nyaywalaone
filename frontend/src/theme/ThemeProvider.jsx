import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'nyaywala-theme';
const THEMES = ['system', 'light', 'dark'];

const ThemeContext = createContext(null);

const readStoredTheme = () => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
};

const systemPrefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * Theme state: `system | light | dark`, persisted in localStorage.
 * <html> gets the class, and `color-scheme` follows it so form controls and
 * scrollbars match the page instead of flashing white in dark mode.
 */
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readStoredTheme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const isDark = theme === 'dark' || (theme === 'system' && systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDark);
    root.style.colorScheme = isDark ? 'dark' : 'light';
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage can be unavailable; the class still applies for this session */
    }
  }, [theme, isDark]);

  const cycleTheme = useCallback(() => {
    setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  }, []);

  const value = useMemo(
    () => ({ theme, isDark, setTheme, cycleTheme, themes: THEMES }),
    [theme, isDark, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
