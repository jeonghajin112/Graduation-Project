import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export type ErrorBoundaryFallbackProps = {
  error: Error;
  resetErrorBoundary: () => void;
};

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback: (props: ErrorBoundaryFallbackProps) => ReactNode;
  resetKey?: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isLazyChunkLoadError(error: Error): boolean {
  return /ChunkLoadError|Loading chunk|dynamically imported module|module script|preload CSS|CSS_CHUNK_LOAD_FAILED/i.test(
    `${error.name} ${error.message}`
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("An application error boundary caught an error.", error, errorInfo);
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps) {
    if (
      this.state.error !== null &&
      previousProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  private resetErrorBoundary = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error !== null) {
      return this.props.fallback({
        error: this.state.error,
        resetErrorBoundary: this.resetErrorBoundary
      });
    }

    return this.props.children;
  }
}
