'use client';

import { useEffect } from 'react';

/**
 * Renders only when the root layout itself fails, so it brings its own
 * <html>/<body> and uses inline styles (no Tailwind, no globals).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Something went wrong</title>
        <style>{`
          :root { --bg: #ffffff; --fg: #0f172a; --muted: #475569; --btn: #1d4ed8; --btn-fg: #ffffff; }
          @media (prefers-color-scheme: dark) {
            :root { --bg: #0b1220; --fg: #f1f5f9; --muted: #cbd5e1; --btn: #3b82f6; --btn-fg: #0b1220; }
          }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          background: 'var(--bg)',
          color: 'var(--fg)',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <main style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.75rem' }}>Something went wrong</h1>
          <p style={{ margin: '0 0 1.5rem', lineHeight: 1.6, color: 'var(--muted)' }}>
            EthiopiaLearn hit an unexpected problem. Reload the page, and if it keeps happening, come back a little later.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: 'var(--btn)',
              color: 'var(--btn-fg)',
              border: 0,
              borderRadius: '0.75rem',
              padding: '0.75rem 1.5rem',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
