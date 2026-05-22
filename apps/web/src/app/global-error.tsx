"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          color: "#111",
          background: "#fafafa",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 460, padding: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🚨</div>
          <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
            Application error
          </h1>
          <p style={{ fontSize: 13, color: "#555", marginBottom: 16 }}>
            {error.message ||
              "Something broke at the root of the app. Reload and try again."}
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: 11,
                color: "#999",
                marginBottom: 16,
              }}
            >
              ref: {error.digest}
            </p>
          )}
          <button
            onClick={() => reset()}
            style={{
              fontSize: 13,
              background: "#111",
              color: "#fff",
              border: 0,
              padding: "8px 16px",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
