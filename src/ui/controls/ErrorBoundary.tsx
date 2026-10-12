import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Rendered instead of the children after they throw. */
  fallback(error: Error, reset: () => void): ReactNode;
  children: ReactNode;
  /** Changing this clears a caught error (e.g. after the plugin hot-reloaded). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  key: unknown;
}

/** Keeps a crashing plugin UI from taking the app down. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { key: props.resetKey, error: null } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[agstudio] plugin UI crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, () => this.setState({ error: null }));
    return this.props.children;
  }
}
