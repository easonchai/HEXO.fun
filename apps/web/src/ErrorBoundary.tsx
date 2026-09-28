/**
 * Ticket 16: a bad API field or an unexpected render error must never leave
 * a depositor on a blank page with no way out. This is the one class
 * component in the app (React 19 has no functional error boundary yet);
 * `main.tsx` mounts it at the top of the tree, above every provider.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { currentPage, reportError } from "./errorReport.js";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  caught: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { caught: error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
    reportError({
      code: "render_error",
      message: error.message,
      page: currentPage(),
    });
  }

  render(): ReactNode {
    if (!this.state.caught) return this.props.children;
    return (
      <div className="screen-note err" role="alert" data-testid="error-boundary">
        <p>Something went wrong.</p>
        <p>
          Your Principal is safe on chain. Reload the page, and if the problem
          keeps happening, use the wallet menu&apos;s withdraw instructions to get
          your money out directly.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
