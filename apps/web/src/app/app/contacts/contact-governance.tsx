'use client';

import { useState } from 'react';

import { messageFor } from '../../../lib/api';
import {
  SUPPRESSION_REASON_LABELS,
  SUPPRESSION_REASONS,
  isSafeConsentSource,
  isSafeReference,
  recordVoiceConsent,
  suppressContact,
  type Contact,
  type SuppressionReason,
} from '../../../lib/contacts';
import { formatDateTime } from '../../../lib/datetime';

/**
 * Consent and suppression controls for one contact.
 *
 * Consent is only ever recorded from evidence an operator supplies. Nothing is
 * defaulted, inferred from an existing field, or back-filled from an import. A
 * second confirmation step makes the consequences explicit: consent evidence is
 * immutable, and suppression cannot be reversed from this application.
 */
export function ContactGovernance({
  organizationId,
  contact,
  canUpdate,
  onUpdated,
}: {
  readonly organizationId: string;
  readonly contact: Contact;
  readonly canUpdate: boolean;
  readonly onUpdated: (contact: Contact) => void;
}): React.JSX.Element {
  const [consentStep, setConsentStep] = useState<'idle' | 'form' | 'confirm'>('idle');
  const [suppressionStep, setSuppressionStep] = useState<'idle' | 'form' | 'confirm'>('idle');
  const [consentedAt, setConsentedAt] = useState('');
  const [source, setSource] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [sourceVerified, setSourceVerified] = useState(false);
  /**
   * No reason is selected until the operator chooses one. Suppression is
   * irreversible and audited, so the form must not put a default reason on the
   * record: whichever reason is stored has to be the one the operator meant.
   */
  const [reason, setReason] = useState<SuppressionReason | ''>('');
  const [busy, setBusy] = useState<'consent' | 'suppression' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const consentRecorded = contact.voiceConsent === 'RECORDED';
  const reasonLabel = reason === '' ? '' : SUPPRESSION_REASON_LABELS[reason];

  function reset(): void {
    setConsentStep('idle');
    setSuppressionStep('idle');
    setConsentedAt('');
    setSource('');
    setEvidenceReference('');
    setSourceVerified(false);
    setReason('');
    setError('');
  }

  function reviewConsent(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError('');

    if (!consentedAt) {
      setError('Enter when the contact gave consent, in your local time.');
      return;
    }
    if (!source.trim()) {
      setError('Enter the source of the consent evidence.');
      return;
    }
    if (!isSafeConsentSource(source)) {
      setError(
        'The source must be 3–80 characters, starting with a letter or digit, using letters, digits, dot, underscore, colon or hyphen, for example signed_form.',
      );
      return;
    }
    if (!isSafeReference(evidenceReference)) {
      setError(
        'The evidence reference must be 3–128 characters using letters, digits, dot, underscore, colon or hyphen.',
      );
      return;
    }
    if (!sourceVerified) {
      setError('Confirm that you verified the source before recording consent.');
      return;
    }
    setConsentStep('confirm');
    setNotice('');
  }

  async function saveConsent(): Promise<void> {
    setBusy('consent');
    setError('');
    try {
      const updated = await recordVoiceConsent(organizationId, contact.id, {
        consentedAt: new Date(consentedAt).toISOString(),
        source: source.trim(),
        purpose: 'voice_calling',
        evidenceReference: evidenceReference.trim(),
        sourceVerified: true,
      });
      onUpdated(updated);
      setNotice('Voice consent evidence recorded. It cannot be edited from this application.');
      reset();
    } catch (cause) {
      setError(messageFor(cause));
      setConsentStep('form');
    } finally {
      setBusy(null);
    }
  }

  async function saveSuppression(): Promise<void> {
    if (reason === '') {
      // Defensive: the confirmation step is unreachable without a reason.
      setError('Select the reason for suppressing this contact.');
      setSuppressionStep('form');
      return;
    }
    setBusy('suppression');
    setError('');
    try {
      const updated = await suppressContact(organizationId, contact.id, reason);
      onUpdated(updated);
      setNotice('Contact suppressed. The record is retained so the opt-out is preserved.');
      reset();
    } catch (cause) {
      setError(messageFor(cause));
      setSuppressionStep('form');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="contact-governance">
      <section aria-labelledby="contact-consent-heading">
        <h3 id="contact-consent-heading">Voice consent</h3>
        {consentRecorded ? (
          <>
            <p>
              Consent evidence was recorded {formatDateTime(contact.voiceConsentAt)}. Consent is
              immutable: it cannot be edited or removed here, and a phone change does not transfer
              it.
            </p>
          </>
        ) : (
          <>
            <p>
              No voice consent is recorded. A contact is not treated as consented because it was
              imported, added manually, or placed in a group.
            </p>
            {canUpdate && consentStep === 'idle' && (
              <button
                className="button-secondary"
                type="button"
                onClick={() => {
                  setConsentStep('form');
                  setError('');
                  setNotice('');
                }}
              >
                Record consent evidence
              </button>
            )}
            {consentStep === 'form' && (
              <form className="contact-governance__form" onSubmit={reviewConsent} noValidate>
                <div className="field">
                  <label htmlFor="consent-at">Consent given at (local time)</label>
                  <input
                    id="consent-at"
                    type="datetime-local"
                    required
                    value={consentedAt}
                    onChange={(event) => setConsentedAt(event.target.value)}
                    disabled={busy !== null}
                    aria-describedby="consent-at-hint"
                  />
                  <span className="field-hint" id="consent-at-hint">
                    Enter the time the contact actually gave consent. Do not use the current time
                    unless it is accurate.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="consent-source">Consent source</label>
                  <input
                    id="consent-source"
                    minLength={3}
                    maxLength={80}
                    required
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                    placeholder="signed_form"
                    disabled={busy !== null}
                    aria-describedby="consent-source-hint"
                  />
                  <span className="field-hint" id="consent-source-hint">
                    A 3-80 character identifier starting with a letter or digit. Letters, digits,
                    dot, underscore, colon or hyphen, for example signed_form or call_recording.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="consent-evidence">Evidence reference</label>
                  <input
                    id="consent-evidence"
                    required
                    value={evidenceReference}
                    onChange={(event) => setEvidenceReference(event.target.value)}
                    placeholder="For example, CRM-2026-00123"
                    disabled={busy !== null}
                    aria-describedby="consent-evidence-hint"
                  />
                  <span className="field-hint" id="consent-evidence-hint">
                    A document, recording or record ID a reviewer can find. Letters, digits, dot,
                    underscore, colon or hyphen.
                  </span>
                </div>
                <label className="contact-governance__check">
                  <input
                    type="checkbox"
                    checked={sourceVerified}
                    onChange={(event) => setSourceVerified(event.target.checked)}
                    disabled={busy !== null}
                  />
                  <span>I verified this evidence and the contact’s voice-calling consent.</span>
                </label>
                <div className="button-row">
                  <button className="button-primary" disabled={busy !== null}>
                    Review consent record
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setConsentStep('idle')}
                    disabled={busy !== null}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {consentStep === 'confirm' && (
              <div
                className="contact-governance__confirm"
                role="alertdialog"
                aria-modal="false"
                aria-labelledby="consent-confirm-title"
              >
                <h4 id="consent-confirm-title">Record this consent evidence?</h4>
                <dl>
                  <dt>Given at</dt>
                  <dd>{formatDateTime(new Date(consentedAt).toISOString())}</dd>
                  <dt>Source</dt>
                  <dd>{source.trim()}</dd>
                  <dt>Evidence reference</dt>
                  <dd>{evidenceReference.trim()}</dd>
                  <dt>Purpose</dt>
                  <dd>Voice calling</dd>
                </dl>
                <p>
                  This becomes the contact’s permanent consent record. It cannot be edited or
                  removed here, and the API records who entered it.
                </p>
                <div className="button-row">
                  <button
                    className="button-primary"
                    type="button"
                    onClick={() => void saveConsent()}
                    disabled={busy !== null}
                  >
                    {busy === 'consent' ? 'Recording…' : 'Confirm and record consent'}
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setConsentStep('form')}
                    disabled={busy !== null}
                  >
                    Go back
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="contact-suppression-heading">
        <h3 id="contact-suppression-heading">Suppression</h3>
        {contact.suppressed ? (
          <p>
            This contact is suppressed as of {formatDateTime(contact.suppressedAt)}. The record is
            retained permanently so the contact is excluded from calling audiences.
          </p>
        ) : (
          <>
            <p>
              Suppression stops a contact from being called. It is irreversible from this
              application, so use it only when there is a real opt-out or an invalid number.
            </p>
            {canUpdate && suppressionStep === 'idle' && (
              <button
                className="button-secondary button-danger"
                type="button"
                onClick={() => {
                  setSuppressionStep('form');
                  setError('');
                  setNotice('');
                }}
              >
                Suppress contact
              </button>
            )}
            {suppressionStep === 'form' && (
              <form
                className="contact-governance__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError('');
                  if (reason === '') {
                    setError('Select the reason for suppressing this contact.');
                    return;
                  }
                  setSuppressionStep('confirm');
                }}
                noValidate
              >
                <div className="field">
                  <label htmlFor="suppression-reason">Reason</label>
                  <select
                    id="suppression-reason"
                    required
                    value={reason}
                    onChange={(event) =>
                      setReason(
                        event.target.value === '' ? '' : (event.target.value as SuppressionReason),
                      )
                    }
                    disabled={busy !== null}
                    aria-describedby="suppression-reason-hint"
                  >
                    <option value="" disabled>
                      Select a reason
                    </option>
                    {SUPPRESSION_REASONS.map((value) => (
                      <option key={value} value={value}>
                        {SUPPRESSION_REASON_LABELS[value]}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint" id="suppression-reason-hint">
                    Choose the reason that actually applies. It becomes part of the permanent,
                    audited suppression record.
                  </span>
                </div>
                <div className="button-row">
                  <button className="button-secondary button-danger" disabled={busy !== null}>
                    Review suppression
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setSuppressionStep('idle')}
                    disabled={busy !== null}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {suppressionStep === 'confirm' && (
              <div
                className="contact-governance__confirm"
                role="alertdialog"
                aria-modal="false"
                aria-labelledby="suppression-confirm-title"
              >
                <h4 id="suppression-confirm-title">Suppress this contact?</h4>
                <p>
                  Reason: {reasonLabel}. The contact will be excluded from calling audiences.
                  Suppression cannot be undone from this application, and the contact record is
                  kept.
                </p>
                <div className="button-row">
                  <button
                    className="button-secondary button-danger"
                    type="button"
                    onClick={() => void saveSuppression()}
                    disabled={busy !== null}
                  >
                    {busy === 'suppression' ? 'Suppressing…' : 'Confirm suppression'}
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setSuppressionStep('form')}
                    disabled={busy !== null}
                  >
                    Go back
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-success" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
