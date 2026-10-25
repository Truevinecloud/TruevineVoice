export default function AppLoading() {
  return (
    <div className="app-loading" aria-busy="true" aria-live="polite">
      <p role="status">Loading your workspace…</p>
      <div className="card app-loading-card" />
    </div>
  );
}
