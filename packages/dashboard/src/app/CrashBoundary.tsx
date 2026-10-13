import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/Button.js';
import { InlineAlert } from '../ui/InlineAlert.js';

/**
 * Short crash reference: base-36 of the timestamp modulo 1,000,000, upper-case.
 * One to four characters, not zero-padded (999999 gives "LFLR"; e.g. "9SGL").
 */
export const crashRef = (at: number): string => (at % 1_000_000).toString(36).toUpperCase();

/**
 * The text Copy details puts on the clipboard: the Ref, route, error and
 * component stack. No API data — a crash report never carries server payloads.
 */
export const crashDetails = (input: {
  error: Error;
  componentStack: string | undefined;
  route: string;
  at: number;
}): string =>
  [
    'Bananasaurs dashboard crash',
    `Ref ${crashRef(input.at)}`,
    `At: ${new Date(input.at).toISOString()}`,
    `Route: ${input.route}`,
    `${input.error.name}: ${input.error.message}`,
    'Component stack:',
    input.componentStack ?? '(no component stack captured)',
  ].join('\n');

interface CrashBoundaryProps {
  readonly children: ReactNode;
  /** Change this to clear a shown crash and render the children again. */
  readonly resetKey: string;
  /** 'app' wraps the whole shell (no menu survives); 'page' wraps one routed page. */
  readonly scope: 'app' | 'page';
}

interface CrashBoundaryState {
  readonly error?: Error | undefined;
  readonly info?: ErrorInfo | undefined;
  readonly at?: number | undefined;
}

/**
 * A crash in one page leaves navigation working (Review Focus 2): the page
 * boundary sits inside `main` around the routed Switch, so the rail renders
 * through any page failure, and a location change (the resetKey) clears it.
 * Class component because React 19 still has no hook for error boundaries.
 */
export class CrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  override state: CrashBoundaryState = {};

  static getDerivedStateFromError(error: Error): CrashBoundaryState {
    return { error, at: Date.now() };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Once per crash, with the Ref, so the browser console can be quoted back.
    console.error('[crash]', crashRef(this.state.at ?? Date.now()), error, info.componentStack);
  }

  override componentDidUpdate(prev: CrashBoundaryProps): void {
    if (this.state.error !== undefined && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined, info: undefined, at: undefined });
    }
  }

  override render(): ReactNode {
    const { error, info, at } = this.state;
    if (error === undefined || at === undefined) return this.props.children;
    const ref = crashRef(at);
    // The page boundary's resetKey IS the current route; the app boundary
    // wraps the shell itself, so fall back to the window's path.
    const route = this.props.scope === 'page' ? this.props.resetKey : window.location.pathname;
    const details = () =>
      crashDetails({ error, componentStack: info?.componentStack ?? undefined, route, at });
    const guidance =
      this.props.scope === 'app'
        ? 'Reload the page to continue.'
        : 'The rest of the dashboard still works — pick another page from the menu.';
    return (
      <InlineAlert
        tone="danger"
        title="This page hit a problem"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => window.location.reload()}>Reload page</Button>
            <Button
              onClick={() => {
                // Best effort, like InlineAlert's reference copy: a denied
                // clipboard write is not operator noise.
                navigator.clipboard?.writeText(details())?.catch(() => undefined);
              }}
            >
              Copy details
            </Button>
            <span className="font-mono text-caption">
              Ref {ref} · {error.name}
            </span>
          </div>
        }
      >
        <p>
          Something in Bananasaurs&apos; dashboard failed while showing this page. Nothing was saved
          or changed.
        </p>
        <p>{guidance}</p>
      </InlineAlert>
    );
  }
}
