export default function HomePage() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ maxWidth: 720, width: '100%', background: '#111827', border: '1px solid #334155', borderRadius: 16, padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>BLOX OpenClaw Bridge</h1>
        <p>This project exposes a webhook endpoint for BLOX web chat.</p>
        <p>
          Health check: <code>/api/blox-webhook</code>
        </p>
      </div>
    </main>
  );
}
