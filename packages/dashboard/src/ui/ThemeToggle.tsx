import { useTheme } from '../app/theme.js';
import { Icon, IconMoon, IconSun } from './icons.js';

/** Sun in dark mode, moon in light: the icon is the scheme a click switches to. */
export function ThemeToggle() {
  const { choice, scheme, setChoice } = useTheme();
  const next = scheme === 'dark' ? 'light' : 'dark';
  const following = choice === 'system' ? ' (following the system right now)' : '';
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode${following}`}
      className="grid size-10 shrink-0 place-items-center rounded-sm border border-line-strong bg-panel text-ink hover:bg-sunk"
    >
      {next === 'light' ? <Icon icon={IconSun} size="md" /> : <Icon icon={IconMoon} size="md" />}
    </button>
  );
}
