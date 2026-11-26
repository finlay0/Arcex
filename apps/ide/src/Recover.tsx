import { Component, type ReactNode } from "react";

/**
 * If drawing the screen fails, this shows a way back instead of a blank window (D9). Threads and drafts live in the
 * engine, so reloading loses nothing; the details can be copied into a bug report.
 */
export class Recover extends Component<{ children: ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error, copied: false };
  }

  componentDidCatch(error: Error) {
    console.error("[arcex] the screen failed to draw", error);
  }

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const details = `${error.message}\n\n${error.stack ?? ""}`.slice(0, 4000);
    return (
      <div className="recover" role="alert">
        <h1>Something on this screen broke</h1>
        <p>Your threads, drafts and projects are safe. Reloading the window usually fixes it.</p>
        <div className="recover-actions">
          <button className="btn primary" onClick={() => location.reload()}>Reload Arcex</button>
          <button
            className="btn"
            onClick={() => void navigator.clipboard?.writeText(details).then(() => this.setState({ copied: true }), () => {})}
          >
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
        <pre>{error.message}</pre>
      </div>
    );
  }
}
