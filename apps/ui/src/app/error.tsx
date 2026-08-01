"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main>
      <div className="pipeline-step-error" style={{ padding: "1rem", borderRadius: "8px", border: "1px solid" }}>
        <h1 style={{ marginTop: 0 }}>Une erreur est survenue</h1>
        <p style={{ whiteSpace: "pre-wrap" }}>{error.message}</p>
        {error.digest && <p className="muted">Référence : {error.digest}</p>}
      </div>
      <p style={{ marginTop: "1rem" }}>
        <button type="button" className="button" onClick={reset}>
          Réessayer
        </button>
      </p>
    </main>
  );
}
