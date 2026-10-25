'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, messageFor, request } from '../../../lib/api';
import {
  groupMembers,
  groupPath,
  groupsPath,
  type ContactGroup,
} from '../../../lib/contact-groups';
import { searchContacts, type Contact, type ContactPage } from '../../../lib/contacts';
import { EmptyState, PageHeader, SectionCard } from '../AppUI';

const emptyPage: ContactPage = { items: [], nextCursor: null };

export function GroupsView({
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
  const [groups, setGroups] = useState<readonly ContactGroup[]>([]);
  const [selected, setSelected] = useState<ContactGroup | null>(null);
  const [members, setMembers] = useState<ContactPage>(emptyPage);
  const [candidates, setCandidates] = useState<readonly Contact[]>([]);
  const [searched, setSearched] = useState(false);
  const [mode, setMode] = useState<'create' | 'rename' | 'delete' | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [recovery, setRecovery] = useState<'sign-in' | 'terms' | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const detail = useRef<HTMLElement>(null);

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
  function clear() {
    setError('');
    setSuccess('');
    setRecovery(null);
  }

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    request<readonly ContactGroup[]>(groupsPath(organizationId))
      .then((result) => {
        if (!cancelled) setGroups(result);
      })
      .catch((value: unknown) => {
        if (!cancelled) failure(value);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      mounted.current = false;
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    detail.current?.focus();
  }, [selected?.id, mode]);

  async function refresh(groupId?: string) {
    const [all, group, page] = await Promise.all([
      request<readonly ContactGroup[]>(groupsPath(organizationId)),
      groupId ? request<ContactGroup>(groupPath(organizationId, groupId)) : Promise.resolve(null),
      groupId ? groupMembers(organizationId, groupId) : Promise.resolve(emptyPage),
    ]);
    if (!mounted.current) return;
    setGroups(all);
    setSelected(group);
    setMembers(page);
  }

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    clear();
    try {
      await work();
    } catch (value) {
      if (mounted.current) failure(value);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function open(group: ContactGroup) {
    setMode(null);
    setCandidates([]);
    setSearched(false);
    await run(async () => {
      await refresh(group.id);
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      if (mode === 'delete' && selected) {
        await request(groupPath(organizationId, selected.id), { method: 'DELETE' });
        await refresh();
        setCandidates([]);
        setSearched(false);
        setSuccess('Group deleted. Contacts were kept.');
      } else {
        const group = await request<ContactGroup>(
          mode === 'rename' && selected
            ? groupPath(organizationId, selected.id)
            : groupsPath(organizationId),
          {
            method: mode === 'rename' ? 'PATCH' : 'POST',
            body: { name: String(form.get('name') ?? '').trim() },
          },
        );
        await refresh(group.id);
        setSuccess(mode === 'rename' ? 'Group renamed.' : 'Group created.');
      }
      setMode(null);
    });
  }

  async function membership(contact: Contact, member: boolean) {
    if (!selected) return;
    await run(async () => {
      const result = await request<{ changed: boolean }>(
        `${groupPath(organizationId, selected.id)}/contacts/${encodeURIComponent(contact.id)}`,
        { method: member ? 'POST' : 'DELETE' },
      );
      await refresh(selected.id);
      setSuccess(
        result.changed
          ? member
            ? 'Contact added to group.'
            : 'Contact removed from group. The contact was kept.'
          : member
            ? 'Contact is already in this group.'
            : 'Contact is already outside this group.',
      );
    });
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('search') ?? '');
    await run(async () => {
      const result = await searchContacts(organizationId, text);
      if (mounted.current) {
        setCandidates(result.items);
        setSearched(true);
      }
    });
  }

  return (
    <>
      <PageHeader
        title="Contact groups"
        eyebrow={organizationName}
        description="Build and maintain reusable audiences from your contacts."
        actions={
          <>
            <a
              className="button-secondary"
              href={`/app/contacts?organization=${encodeURIComponent(organizationId)}`}
            >
              View contacts
            </a>
            <button
              className="button-secondary"
              disabled={busy}
              onClick={() => {
                void run(() => refresh(selected?.id));
              }}
            >
              Refresh groups
            </button>
            {canCreate && (
              <button
                className="button-primary"
                disabled={busy}
                onClick={() => {
                  clear();
                  setMode('create');
                }}
              >
                Create group
              </button>
            )}
          </>
        }
      />
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
      {busy && (
        <p className="loading-message" role="status">
          Loading or saving groups…
        </p>
      )}
      {!busy && !error && groups.length === 0 && (
        <SectionCard>
          <EmptyState title="No groups yet.">
            Create a group to organize contacts for campaign audiences.
          </EmptyState>
        </SectionCard>
      )}
      <div className="contacts-list" aria-busy={busy}>
        {groups.map((group) => (
          <article className="card-section contact-row" key={group.id}>
            <div>
              <h2>{group.name}</h2>
              <p>{group.memberCount} contacts</p>
            </div>
            <button
              className="button-secondary"
              disabled={busy}
              onClick={() => {
                void open(group);
              }}
              aria-label={`View group ${group.name}`}
            >
              View group
            </button>
          </article>
        ))}
      </div>
      {mode && (
        <section
          className="card-section contact-editor"
          aria-label="Group editor"
          tabIndex={-1}
          ref={detail}
        >
          <h2>
            {mode === 'create'
              ? 'Create group'
              : mode === 'rename'
                ? 'Rename group'
                : 'Delete group'}
          </h2>
          <form
            key={`${mode}-${selected?.id ?? 'new'}`}
            onSubmit={(event) => {
              void save(event);
            }}
          >
            {mode === 'delete' ? (
              <p>
                Delete {selected?.name}? Only the group and its memberships will be removed.
                Contacts and campaign history will be kept. This cannot be undone.
              </p>
            ) : (
              <div className="field">
                <label htmlFor="group-name">Group name</label>
                <input
                  id="group-name"
                  name="name"
                  required
                  maxLength={120}
                  disabled={busy}
                  defaultValue={mode === 'rename' ? selected?.name : ''}
                />
              </div>
            )}
            <button className="button-secondary" disabled={busy}>
              {mode === 'delete' ? 'Confirm group deletion' : 'Save group'}
            </button>
            <button
              className="button-secondary"
              type="button"
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Cancel
            </button>
          </form>
        </section>
      )}
      {selected && !mode && (
        <section
          className="card-section contact-editor"
          aria-label="Group details"
          tabIndex={-1}
          ref={detail}
        >
          <h2>{selected.name}</h2>
          <p>{selected.memberCount} contacts</p>
          <button
            className="button-secondary"
            disabled={busy}
            onClick={() => {
              clear();
              setSelected(null);
              setMembers(emptyPage);
              setCandidates([]);
              setSearched(false);
            }}
          >
            Close group
          </button>
          {canUpdate && (
            <div className="row">
              <button
                className="button-secondary"
                disabled={busy}
                onClick={() => {
                  clear();
                  setMode('rename');
                }}
              >
                Rename group
              </button>
              <button
                className="button-secondary button-danger"
                disabled={busy}
                onClick={() => {
                  clear();
                  setMode('delete');
                }}
              >
                Delete group
              </button>
            </div>
          )}
          <h3>Group contacts</h3>
          {members.items.length === 0 && <p>This group has no contacts.</p>}
          <ul>
            {members.items.map((contact) => (
              <li key={contact.id}>
                {contact.name || 'Unnamed contact'} — {contact.phone}
                {canUpdate && (
                  <button
                    className="button-secondary"
                    disabled={busy}
                    aria-label={`Remove ${contact.name || contact.phone} from group`}
                    onClick={() => {
                      void membership(contact, false);
                    }}
                  >
                    Remove from group
                  </button>
                )}
              </li>
            ))}
          </ul>
          {members.nextCursor && (
            <button
              className="button-secondary"
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  const page = await groupMembers(
                    organizationId,
                    selected.id,
                    members.nextCursor ?? undefined,
                  );
                  setMembers({
                    ...page,
                    items: [
                      ...new Map(
                        [...members.items, ...page.items].map((contact) => [contact.id, contact]),
                      ).values(),
                    ],
                  });
                });
              }}
            >
              Load more group contacts
            </button>
          )}
          {canUpdate && (
            <>
              <h3>Add existing contacts</h3>
              <p>Group membership does not grant consent or change suppression.</p>
              <form
                onSubmit={(event) => {
                  void search(event);
                }}
              >
                <div className="field">
                  <label htmlFor="group-contact-search">
                    Find contacts by name, phone or email
                  </label>
                  <input id="group-contact-search" name="search" type="search" disabled={busy} />
                </div>
                <button className="button-secondary" disabled={busy}>
                  Find contacts
                </button>
              </form>
              {searched && candidates.length === 0 && <p>No matching contacts.</p>}
              <ul>
                {candidates.map((contact) => (
                  <li key={contact.id}>
                    {contact.name || 'Unnamed contact'} — {contact.phone}
                    <button
                      className="button-secondary"
                      disabled={busy || members.items.some((entry) => entry.id === contact.id)}
                      aria-label={`Add ${contact.name || contact.phone} to group`}
                      onClick={() => {
                        void membership(contact, true);
                      }}
                    >
                      Add to group
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
