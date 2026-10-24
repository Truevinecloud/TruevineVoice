'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, messageFor, request } from '../../../lib/api';
import {
  contactsPath,
  listContacts,
  searchContacts,
  type Contact,
  type ContactPage,
} from '../../../lib/contacts';

export function ContactsView({
  organizationId,
  organizationName,
  canCreate,
  canUpdate,
}: {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly canCreate: boolean;
  readonly canUpdate: boolean;
}) {
  const [page, setPage] = useState<ContactPage>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<'sign-in' | 'terms' | null>(null);
  const [success, setSuccess] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [mode, setMode] = useState<'view' | 'add' | 'edit' | 'delete' | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const mutation = useRef(false);
  const editor = useRef<HTMLElement>(null);

  useEffect(() => {
    editor.current?.focus();
  }, [mode, selected?.id]);

  function failure(value: unknown) {
    setError(messageFor(value));
    setRecovery(
      value instanceof ApiError && value.isUnauthenticated
        ? 'sign-in'
        : value instanceof ApiError && value.code === 'terms_acceptance_required'
          ? 'terms'
          : null,
    );
  }

  useEffect(() => {
    mounted.current = true;
    const version = ++generation.current;
    listContacts(organizationId)
      .then((result) => {
        if (mounted.current && generation.current === version) {
          setPage(result);
          setLoading(false);
        }
      })
      .catch((value: unknown) => {
        if (mounted.current && generation.current === version) {
          failure(value);
          setLoading(false);
        }
      });
    return () => {
      mounted.current = false;
    };
  }, [organizationId]);

  async function load(text: string, more = false) {
    const version = ++generation.current;
    setLoading(true);
    setError('');
    setRecovery(null);
    setSuccess('');
    try {
      const result = text.trim()
        ? await searchContacts(organizationId, text)
        : await listContacts(organizationId, more ? (page.nextCursor ?? undefined) : undefined);
      if (!mounted.current || generation.current !== version) return;
      setPage((previous) =>
        more
          ? {
              ...result,
              items: [
                ...new Map(
                  [...previous.items, ...result.items].map((item) => [item.id, item]),
                ).values(),
              ],
            }
          : result,
      );
      setSearch(text);
    } catch (value) {
      if (mounted.current && generation.current === version) failure(value);
    } finally {
      if (mounted.current && generation.current === version) setLoading(false);
    }
  }

  function open(next: typeof mode, contact: Contact | null = null) {
    setSelected(contact);
    setMode(next);
    setError('');
    setRecovery(null);
    setSuccess('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.current) return;
    const form = new FormData(event.currentTarget);
    mutation.current = true;
    setBusy(true);
    setError('');
    setRecovery(null);
    setSuccess('');
    try {
      const base = contactsPath(organizationId);
      if (mode === 'delete' && selected) {
        await request(`${base}/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
        setPage((previous) => ({
          ...previous,
          items: previous.items.filter((item) => item.id !== selected.id),
        }));
        setSuccess('Contact deleted.');
      } else {
        const fields = {
          name: String(form.get('name') ?? '').trim(),
          email: String(form.get('email') ?? '').trim(),
        };
        const contact = await request<Contact>(
          mode === 'edit' && selected ? `${base}/${encodeURIComponent(selected.id)}` : base,
          {
            method: mode === 'edit' ? 'PATCH' : 'POST',
            body: { ...fields, ...(form.has('phone') ? { phone: String(form.get('phone')) } : {}) },
          },
        );
        setPage((previous) => ({
          ...previous,
          items:
            mode === 'edit'
              ? previous.items.map((item) => (item.id === contact.id ? contact : item))
              : [contact, ...previous.items],
        }));
        setSelected(contact);
        setMode('view');
        setSuccess(mode === 'edit' ? 'Contact saved.' : 'Contact added.');
      }
      if (mode === 'delete') {
        setSelected(null);
        setMode(null);
      }
    } catch (value) {
      failure(value);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div className="contacts-toolbar">
        <div>
          <h1 className="page-title">Contacts</h1>
          <p>{organizationName}</p>
        </div>
        {canCreate && (
          <button
            className="button-secondary"
            disabled={busy || loading}
            onClick={() => open('add')}
          >
            Add Contact
          </button>
        )}
      </div>
      <form
        className="contacts-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void load(query);
        }}
      >
        <div className="field contacts-search">
          <label htmlFor="contact-search">Search contacts</label>
          <input
            id="contact-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, phone or email"
            disabled={busy || loading}
          />
        </div>
        <button className="button-secondary" disabled={loading || busy}>
          Search
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={loading || busy}
          onClick={() => {
            setQuery('');
            void load('');
          }}
        >
          Refresh / clear
        </button>
      </form>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}{' '}
          {recovery === 'sign-in' && <a href="/sign-in?reason=session-ended">Sign in again</a>}
          {recovery === 'terms' && <a href="/accept-terms">Review terms</a>}
        </div>
      )}
      {success && (
        <p className="notice notice-success" role="status">
          {success}
        </p>
      )}
      {loading && <p role="status">Loading contacts…</p>}
      {!loading && !error && page.items.length === 0 && (
        <p>
          {search.trim()
            ? 'No contacts match your search.'
            : 'No contacts yet. Add your first contact to get started.'}
        </p>
      )}
      <div className="contacts-list" aria-busy={loading}>
        {page.items.map((contact) => (
          <article className="card-section contact-row" key={contact.id}>
            <div>
              <h2>{contact.name || 'Unnamed contact'}</h2>
              <p>{contact.phone}</p>
              {contact.email && <p>{contact.email}</p>}
              {contact.suppressed && <span className="tag">Suppressed</span>}
            </div>
            <button
              className="button-secondary"
              disabled={busy || loading}
              onClick={() => open('view', contact)}
              aria-label={`View contact ${contact.name || contact.phone}`}
            >
              View Contact
            </button>
          </article>
        ))}
      </div>
      {page.nextCursor && (
        <button
          className="button-secondary"
          disabled={loading || busy}
          onClick={() => {
            void load('', true);
          }}
        >
          Load more contacts
        </button>
      )}
      {mode && (
        <section
          className="card-section contact-editor"
          aria-labelledby="contact-editor-title"
          tabIndex={-1}
          ref={editor}
        >
          <h2 id="contact-editor-title">
            {mode === 'add'
              ? 'Add Contact'
              : mode === 'edit'
                ? 'Edit Contact'
                : mode === 'delete'
                  ? 'Delete Contact'
                  : 'Contact details'}
          </h2>
          {mode === 'view' && selected ? (
            <>
              <dl>
                <dt>Name</dt>
                <dd>{selected.name || 'Not provided'}</dd>
                <dt>Phone</dt>
                <dd>{selected.phone}</dd>
                <dt>Email</dt>
                <dd>{selected.email || 'Not provided'}</dd>
                <dt>Voice consent</dt>
                <dd>
                  {selected.voiceConsent === 'RECORDED'
                    ? `Recorded: ${selected.voiceConsentAt}`
                    : 'Not recorded'}
                </dd>
                <dt>Suppression</dt>
                <dd>
                  {selected.suppressed ? `Suppressed: ${selected.suppressedAt}` : 'Not suppressed'}
                </dd>
                <dt>Created</dt>
                <dd>{selected.createdAt}</dd>
                <dt>Updated</dt>
                <dd>{selected.updatedAt}</dd>
              </dl>
              {canUpdate && (
                <div className="row">
                  <button className="button-secondary" onClick={() => open('edit', selected)}>
                    Edit Contact
                  </button>
                  <button
                    className="button-secondary button-danger"
                    disabled={selected.suppressed}
                    onClick={() => open('delete', selected)}
                  >
                    Delete Contact
                  </button>
                </div>
              )}
              {selected.suppressed && (
                <p>Suppressed contacts are retained to preserve the opt-out.</p>
              )}
            </>
          ) : (
            <form
              key={`${mode}-${selected?.id ?? 'new'}`}
              onSubmit={(event) => {
                void save(event);
              }}
            >
              {mode === 'delete' ? (
                <p>
                  Delete {selected?.name || selected?.phone}? This cannot be undone. Contacts
                  referenced by campaigns cannot be deleted.
                </p>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="contact-phone">Phone</label>
                    <input
                      id="contact-phone"
                      name="phone"
                      type="tel"
                      required
                      maxLength={80}
                      defaultValue={selected?.phone ?? ''}
                      disabled={
                        busy ||
                        (mode === 'edit' &&
                          (selected?.suppressed === true || selected?.voiceConsent === 'RECORDED'))
                      }
                      aria-describedby="contact-phone-hint"
                    />
                    <span id="contact-phone-hint" className="field-hint">
                      Use an international number or a Uganda local number. The server normalizes it
                      to E.164. Phone changes are allowed only without consent evidence, suppression
                      or campaign history. Restricted records must be kept; create a separate
                      contact for a different number. Consent does not transfer.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="contact-name">Name (optional)</label>
                    <input
                      id="contact-name"
                      name="name"
                      maxLength={200}
                      defaultValue={selected?.name ?? ''}
                      disabled={busy}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="contact-email">Email (optional)</label>
                    <input
                      id="contact-email"
                      name="email"
                      type="email"
                      maxLength={254}
                      defaultValue={selected?.email ?? ''}
                      disabled={busy}
                    />
                  </div>
                </>
              )}
              <button
                className={`button-secondary ${mode === 'delete' ? 'button-danger' : ''}`}
                disabled={busy}
              >
                {busy ? 'Saving…' : mode === 'delete' ? 'Confirm deletion' : 'Save Contact'}
              </button>
            </form>
          )}
          <button
            className="button-secondary contact-close"
            disabled={busy}
            onClick={() => {
              setMode(null);
              setSelected(null);
            }}
          >
            Close
          </button>
        </section>
      )}
    </>
  );
}
