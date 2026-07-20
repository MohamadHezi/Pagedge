import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import "pdfjs-dist/web/pdf_viewer.css";

// Only initializes if VITE_SENTRY_DSN is set at build time — an empty/missing
// DSN makes the SDK a no-op, so this is safe to ship before a Sentry project
// even exists. Also captures unhandled window errors/rejections by default,
// on top of what ErrorBoundary forwards for React render errors.
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  tracesSampleRate: 0.1,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
