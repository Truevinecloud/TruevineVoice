import { redirect } from 'next/navigation';

import { currentSession, hasPermission } from '../../../lib/session';
import { AudioLibrary } from './audio-library';
import { PageHeader } from '../AppUI';

export default async function AudioPage({
  searchParams,
}: {
  searchParams: Promise<{ organization?: string | string[] }>;
}): Promise<React.JSX.Element> {
  const session = await currentSession();
  if (!session.ok) redirect('/sign-in');
  if (!session.me.termsAccepted) redirect('/accept-terms');
  const params = await searchParams;
  const requested = Array.isArray(params.organization)
    ? params.organization[0]
    : params.organization;
  const membership = requested
    ? session.me.memberships.find((item) => item.organizationId === requested)
    : session.me.memberships[0];
  if (!membership || !hasPermission(membership, 'audio:read'))
    return (
      <>
        <PageHeader title="Audio Library" />
        <p className="notice notice-error" role="alert">
          You do not have audio access in this organization.
        </p>
      </>
    );
  const canCreate = hasPermission(membership, 'audio:create');
  return (
    <>
      <PageHeader
        title="Audio Library"
        eyebrow={membership.organizationName}
        description="Review campaign audio assets and prepare new recordings when secure storage is configured."
      />
      <AudioLibrary organizationId={membership.organizationId} canCreate={canCreate} />
    </>
  );
}
