import { Component } from "react";

/**
 * ErrorBoundary:
 * Catches rendering, lifecycle, and lazy-chunk errors in child component trees.
 * Prevents an unexplained white blank screen and provides retry & recovery actions.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[ErrorBoundary] Caught runtime rendering error:", error, errorInfo);
    this.setState({ errorInfo });
    if (typeof this.props.onError === "function") {
      try {
        this.props.onError(error, errorInfo);
      } catch (callbackErr) {
        console.warn("[ErrorBoundary] onError callback failed:", callbackErr);
      }
    }
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && Array.isArray(this.props.resetKeys) && Array.isArray(prevProps.resetKeys)) {
      const changed =
        this.props.resetKeys.length !== prevProps.resetKeys.length ||
        this.props.resetKeys.some((key, index) => !Object.is(key, prevProps.resetKeys[index]));
      if (changed) {
        this.setState({ hasError: false, error: null, errorInfo: null });
      }
    }
  }

  handleRetry() {
    this.setState({ hasError: false, error: null, errorInfo: null });
    if (typeof this.props.onRetry === "function") {
      this.props.onRetry();
    }
  }

  handleReload() {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback({
          error: this.state.error,
          errorInfo: this.state.errorInfo,
          retry: this.handleRetry,
          reload: this.handleReload,
        });
      }

      const errorMessage =
        this.state.error?.message || "An unexpected rendering error occurred in this view.";
      const isChunkError =
        /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
          errorMessage
        );

      return (
        <div
          role="alert"
          style={{
            minHeight: this.props.inline ? "280px" : "calc(100vh - 68px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "32px 20px",
            background: "var(--bg-main, #F8FAFC)",
            fontFamily: "var(--font-sans, 'Montserrat', sans-serif)",
          }}
        >
          <div
            style={{
              maxWidth: 540,
              width: "100%",
              background: "#FFFFFF",
              border: "1px solid var(--border-light, #E2E8F0)",
              borderRadius: 14,
              padding: "28px 24px",
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.06)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: "#FEE2E2",
                color: "#DC2626",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.4rem",
                fontWeight: 800,
                margin: "0 auto 14px",
              }}
            >
              !
            </div>

            <span className="pill-badge pill-tech" style={{ marginBottom: 8 }}>
              {this.props.titleBadge || "APPLICATION RECOVERY"}
            </span>

            <h2
              style={{
                fontSize: "1.35rem",
                fontWeight: 800,
                color: "var(--text-primary, #231112)",
                margin: "4px 0 8px",
              }}
            >
              {isChunkError
                ? "Page Module Failed to Load"
                : this.props.title || "Something went wrong while rendering this view"}
            </h2>

            <p
              style={{
                fontSize: "0.9rem",
                color: "var(--text-secondary, #4A3537)",
                lineHeight: 1.55,
                margin: "0 0 16px",
              }}
            >
              {isChunkError
                ? "A network interruption prevented loading the latest page bundle. Please retry or reload the page."
                : "We encountered an unexpected runtime error. Your session and data remain safe."}
            </p>

            {errorMessage && (
              <div
                style={{
                  background: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  padding: "10px 12px",
                  marginBottom: 20,
                  textAlign: "left",
                  fontSize: "0.78rem",
                  color: "#64748B",
                  fontFamily: "monospace",
                  wordBreak: "break-word",
                }}
              >
                {errorMessage}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-solid-dark btn-sm"
                onClick={isChunkError ? this.handleReload : this.handleRetry}
              >
                {isChunkError ? "Reload Application" : "Try Again"}
              </button>

              {!isChunkError && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={this.handleReload}
                >
                  Reload Page
                </button>
              )}

              {!this.props.inline && (
                <a
                  href="/"
                  className="btn btn-outline btn-sm"
                  style={{ textDecoration: "none" }}
                >
                  Return Home
                </a>
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
