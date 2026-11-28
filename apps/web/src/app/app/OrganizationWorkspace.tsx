'use client';

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, request } from '../../lib/api';
import { selectMembership } from '../../lib/organization-context';
import type { Me, MembershipSummary } from '../../lib/session';
import { AppNavigation } from './AppNavigation';
import { OrganizationAccessDenied } from './AppUI';

export function WorkspaceLoading() {
  return (
    <div className="workspace-loading" aria-busy="true">
      <p role="status">Loading your authorized workspace...</p>
      <div className="workspace-skeleton" aria-hidden="true">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}

/** Revalidate cached routes and restored tabs before displaying tenant content. */
function AuthorizedWorkspaceContent({
  membership,
  userId,
  children,
  onSessionEnded,
}: {
  membership: MembershipSummary;
  userId: string;
  children: ReactNode;
  onSessionEnded: () => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<
    'checking' | 'ready' | 'denied' | 'expired' | 'error' | 'changed'
  >('checking');
  const [revision, setRevision] = useState(0);
  const [released, setReleased] = useState(false);
  const permissionKey = [...membership.permissions].sort().join(',');
  useEffect(() => {
    let controller: AbortController | undefined;
    let mounted = true;
    const verify = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      setStatus('checking');
      try {
        const me = await request<Me>('/me', { signal: current.signal });
        if (!mounted || current.signal.aborted) return;
        const fresh = selectMembership(me.memberships, membership.organizationId);
        if (me.userId !== userId) {
          setStatus('expired');
          onSessionEnded();
        } else if (!me.termsAccepted) {
          setStatus('denied');
          router.push('/accept-terms');
        } else if (!fresh) {
          setStatus('denied');
          router.refresh();
        } else if (
          fresh.role !== membership.role ||
          [...fresh.permissions].sort().join(',') !== permissionKey
        ) {
          setStatus('changed');
          router.refresh();
        } else {
          setReleased(true);
          setStatus('ready');
          // Refresh the layout too: another membership may have been revoked
          // even when the currently selected membership is unchanged.
          router.refresh();
        }
      } catch (error) {
        if (mounted && !current.signal.aborted) {
          setStatus(error instanceof ApiError && error.status === 401 ? 'expired' : 'error');
          if (error instanceof ApiError && error.status === 401) onSessionEnded();
        }
      }
    };
    const onVisible = () => {
      if (!document.hidden) void verify();
    };
    const timer = window.setTimeout(() => void verify(), 0);
    window.addEventListener('pageshow', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted = false;
      controller?.abort();
      window.clearTimeout(timer);
      window.removeEventListener('pageshow', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [
    membership.organizationId,
    membership.role,
    permissionKey,
    userId,
    router,
    revision,
    onSessionEnded,
  ]);
  if (status === 'denied') return <OrganizationAccessDenied />;
  if (status === 'expired')
    return (
      <section className="card workspace-access-state" role="alert">
        <h1>Your session has ended</h1>
        <p>Sign in again to open your workspace.</p>
        <a className="button-primary" href="/sign-in?reason=session-ended">
          Sign in
        </a>
      </section>
    );
  if (status === 'error' || status === 'changed')
    return (
      <section className="card workspace-access-state" role="alert">
        <h1>Workspace unavailable</h1>
        <p>
          {status === 'changed'
            ? 'Your workspace permissions changed. Reload to continue.'
            : 'Your workspace access could not be verified. Please try again.'}
        </p>
        <button
          className="button-primary"
          onClick={() => {
            setStatus('checking');
            router.refresh();
            setRevision((value) => value + 1);
          }}
        >
          Retry
        </button>
      </section>
    );
  return (
    <>
      {status === 'checking' && <WorkspaceLoading />}
      {released && (
        <div hidden={status !== 'ready'} inert={status !== 'ready'}>
          {children}
        </div>
      )}
    </>
  );
}

/** URL context is tab-local. Changing it remounts every stateful tenant view. */
export function OrganizationWorkspace({
  memberships,
  email,
  userId,
  children,
}: {
  readonly memberships: readonly MembershipSummary[];
  readonly email: string;
  readonly userId: string;
  readonly children: ReactNode;
}) {
  const parameters = useSearchParams();
  const requested = parameters.has('organization') ? parameters.getAll('organization') : undefined;
  const selected = selectMembership(memberships, requested);
  const key = `${userId}:${selected?.organizationId ?? 'unavailable'}:${selected?.role ?? ''}:${selected?.permissions.join(',') ?? ''}`;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{ message: string; expired: boolean } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const onSessionEnded = useCallback(
    () =>
      setFailure({
        expired: true,
        message: 'Your session has ended. Sign in again to open a workspace.',
      }),
    [],
  );

  useEffect(() => () => activeRequest.current?.abort(), [key]);

  function switchOrganization(organizationId: string) {
    if (pending || !selectMembership(memberships, organizationId)) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setFailure(null);
    startTransition(async () => {
      try {
        const me = await request<Me>('/me', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (me.userId !== userId) throw new ApiError(401, 'session_changed', 'Session changed');
        if (!me.termsAccepted) {
          router.push('/accept-terms');
          return;
        }
        if (!selectMembership(me.memberships, organizationId)) {
          throw new ApiError(403, 'permission_denied', 'Membership changed');
        }
        startTransition(() => {
          router.push(`/app?organization=${encodeURIComponent(organizationId)}`);
          router.refresh();
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const expired = error instanceof ApiError && error.status === 401;
        setFailure({
          expired,
          message: expired
            ? 'Your session has ended. Sign in again to open a workspace.'
            : 'This workspace could not be opened. Your access may have changed. Try again or choose another workspace.',
        });
      }
    });
  }

  return (
    <div className="app-shell">
      {failure?.expired ? (
        <header className="app-topbar">
          <a className="app-brand" href="/sign-in">
            Truevine Voice
          </a>
        </header>
      ) : (
        <AppNavigation
          memberships={memberships}
          email={email}
          onChooseOrganization={switchOrganization}
          switching={pending}
        />
      )}
      <main className="app-main" id="main-content" tabIndex={-1} aria-busy={pending}>
        <div className="page-content" key={key}>
          {failure && (
            <div className="notice notice-error" role="alert">
              <p>{failure.message}</p>
              {failure.expired && (
                <a className="button-primary" href="/sign-in?reason=session-ended">
                  Sign in
                </a>
              )}
            </div>
          )}
          {pending ? (
            <WorkspaceLoading />
          ) : failure?.expired ? null : requested && !selected ? (
            <OrganizationAccessDenied />
          ) : selected ? (
            <AuthorizedWorkspaceContent
              membership={selected}
              userId={userId}
              onSessionEnded={onSessionEnded}
            >
              {children}
            </AuthorizedWorkspaceContent>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}
