/**
 * Hero illustration (TV-WEB-001).
 *
 * A layered, CSS-composed product preview: a phone receiving an automated
 * Truevine Voice call, a floating campaign-performance card, a call-results
 * card and a local-language voice card. Built from HTML and inline SVG - no
 * raster assets.
 *
 * Every figure shown here is illustrative sample data, labelled as such both
 * visibly and through the group's accessible name. None of it is real customer
 * data, and none of it implies the calling product is live.
 */

const CAMPAIGNS = [
  { name: 'Water bill reminder', percent: 92 },
  { name: 'Clinic appointment follow-ups', percent: 78 },
] as const;

const RESULTS = [
  { label: 'Connected', count: '1,042', tone: 'connected' as const },
  { label: 'No answer', count: '143', tone: 'no-answer' as const },
  { label: 'Voicemail', count: '63', tone: 'voicemail' as const },
] as const;

const LANGUAGES = ['Luganda', 'Swahili', 'English'] as const;

const WAVE_HEIGHTS = [8, 14, 20, 11, 24, 16, 10, 18, 13, 7] as const;

/** Wave heights are authored as fractions of an `em` so the bars scale with
 * the illustration's container font size rather than staying fixed in pixels. */
function waveEm(px: number): string {
  return `${(px / 12).toFixed(2)}em`;
}

export function HeroShowcase(): React.JSX.Element {
  return (
    <div
      className="mk-showcase"
      role="img"
      aria-label="Illustrative product preview: a phone receiving an automated Truevine Voice call, with sample campaign performance, call results and local-language voice cards. All figures are sample data."
    >
      <div className="mk-showcase-glow" aria-hidden="true" />
      <div className="mk-showcase-ring mk-showcase-ring-a" aria-hidden="true" />
      <div className="mk-showcase-ring mk-showcase-ring-b" aria-hidden="true" />

      <div className="mk-float-card mk-card-performance">
        <div className="mk-float-head">
          <span className="mk-float-title">Campaign performance</span>
          <span className="mk-sample-tag">Sample</span>
        </div>
        {CAMPAIGNS.map((campaign) => (
          <div key={campaign.name} className="mk-campaign-row">
            <div className="mk-campaign-meta">
              <span className="mk-campaign-name">{campaign.name}</span>
              <span className="mk-campaign-percent">{campaign.percent}%</span>
            </div>
            <div className="mk-progress">
              <div className="mk-progress-fill" style={{ width: `${campaign.percent}%` }} />
            </div>
          </div>
        ))}
        <p className="mk-float-foot">1,248 contacts reached</p>
      </div>

      <div className="mk-float-card mk-card-results">
        <div className="mk-float-head">
          <span className="mk-float-title">Call results</span>
          <span className="mk-sample-tag">Sample</span>
        </div>
        <div className="mk-stack-bar" aria-hidden="true">
          <span className="mk-stack-connected" style={{ flex: 1042 }} />
          <span className="mk-stack-no-answer" style={{ flex: 143 }} />
          <span className="mk-stack-voicemail" style={{ flex: 63 }} />
        </div>
        <ul className="mk-result-legend">
          {RESULTS.map((result) => (
            <li key={result.label} className={`mk-result-item mk-result-${result.tone}`}>
              <span className="mk-result-dot" aria-hidden="true" />
              <span className="mk-result-label">{result.label}</span>
              <span className="mk-result-count">{result.count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mk-phone" aria-hidden="true">
        <div className="mk-phone-notch" />
        <div className="mk-phone-screen">
          <p className="mk-call-status">Incoming call</p>
          <div className="mk-call-avatar">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" focusable="false">
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11.3 21 3 12.7 3 2.5 3 1.9 3.4 1.5 4 1.5h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .7-.2 1L6.6 10.8z" />
            </svg>
          </div>
          <p className="mk-call-name">Truevine Voice</p>
          <p className="mk-call-sub">Automated call</p>
          <div className="mk-call-lang">
            <span className="mk-call-lang-label">Luganda voice</span>
            <span className="mk-wave mk-wave-sm">
              {WAVE_HEIGHTS.slice(0, 6).map((height, index) => (
                <span key={index} style={{ height: waveEm(Math.max(5, height - 2)) }} />
              ))}
            </span>
          </div>
          <div className="mk-call-actions">
            <span className="mk-call-btn mk-call-decline">
              <svg width="18" height="18" viewBox="0 0 24 24" focusable="false">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="mk-call-btn mk-call-accept">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" focusable="false">
                <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11.3 21 3 12.7 3 2.5 3 1.9 3.4 1.5 4 1.5h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .7-.2 1L6.6 10.8z" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      <div className="mk-float-card mk-card-voice">
        <div className="mk-float-head">
          <span className="mk-float-title">Local-language voice</span>
          <span className="mk-sample-tag">Preview</span>
        </div>
        <span className="mk-wave mk-wave-lg" aria-hidden="true">
          {WAVE_HEIGHTS.map((height, index) => (
            <span key={index} style={{ height: waveEm(height) }} />
          ))}
        </span>
        <div className="mk-lang-chips">
          {LANGUAGES.map((language) => (
            <span key={language} className="mk-lang-chip">
              {language}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
