export default function AppLoading() {
  return (
    <main className="app-main" aria-busy="true" aria-live="polite">
      <p role="status">Loading your workspace…</p>
      <div className="card app-loading-card" />
    </main>
  );
}
