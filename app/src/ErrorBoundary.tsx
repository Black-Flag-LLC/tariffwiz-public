import { Component, type ReactNode } from 'react';

/** Last line of defence: a render error shows a way out instead of a blank page. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
        <p>The calculator hit an error showing this quote. Your data never left this browser.</p>
        <p><button onClick={() => { location.href = location.pathname; }}>Start a new quote</button></p>
        <details><summary>Details</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error.message)}</pre></details>
      </div>
    );
  }
}
