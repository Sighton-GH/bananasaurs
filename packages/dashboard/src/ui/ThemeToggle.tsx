import { useTheme } from '../app/theme.js';

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

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
      className="grid size-10 shrink-0 place-items-center rounded-sm border border-line bg-panel text-ink hover:text-ink-muted"
    >
      {next === 'light' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
