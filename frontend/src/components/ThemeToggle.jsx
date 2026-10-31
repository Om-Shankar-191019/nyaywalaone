import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme/ThemeProvider.jsx';

const ICONS = { system: Monitor, light: Sun, dark: Moon };

/**
 * Cycles system -> light -> dark. `aria-pressed` reports whether the page is
 * currently dark, and the label names the current choice, because "moon icon"
 * alone tells a screen reader nothing.
 */
export function ThemeToggle({ className = '' }) {
  const { theme, isDark, cycleTheme } = useTheme();
  const Icon = ICONS[theme];

  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-pressed={isDark}
      aria-label={`Theme: ${theme}. Activate to switch theme.`}
      title={`Theme: ${theme}`}
      className={`inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium capitalize text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${className}`}
    >
      <Icon aria-hidden="true" size={15} />
      <span className="hidden sm:inline">{theme}</span>
    </button>
  );
}
