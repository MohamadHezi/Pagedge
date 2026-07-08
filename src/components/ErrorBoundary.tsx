import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Top-level safety net: any uncaught render error below this point would
// otherwise unmount the whole React tree and leave a blank window with no
// way to recover short of force-quitting the app.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            height: "100vh",
            width: "100vw",
            padding: 32,
            textAlign: "center",
            background: "#0e0e0e",
            color: "#eee0d2",
            fontFamily: "Inter, sans-serif",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: "#d7c3ae", maxWidth: 480 }}>
            Pagedge hit an unexpected error and couldn't continue rendering.
            Your data is safe — restarting the app should fix this.
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#8a7d6d",
              maxWidth: 480,
              fontFamily: "JetBrains Mono, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message}
          </div>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              marginTop: 8,
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid rgba(159, 142, 122, 0.18)",
              background: "#ffc880",
              color: "#161309",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload Pagedge
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
