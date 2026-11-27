'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';

import { ensureCsrfToken, messageFor, request } from '../../../../lib/api';
import type { Me, MembershipSummary } from '../../../../lib/session';
import { selectMembership } from '../../../../lib/organization-context';
import { hasPermission } from '../../../../lib/permissions';
import type { Member, Role, RoleAssignment } from '../../../../lib/role-types';
import { PageHeader, SectionCard, Tag, ConfirmDialog } from '../../AppUI';

export default function RoleDetailPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const roleId = params.roleId as string;
  const organizationId = searchParams.get('organization') ?? '';

  const [membership, setMembership] = useState<MembershipSummary | null>(null);
  const [currentUserId, setCurrentUserId] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [assignments, setAssignments] = useState<readonly RoleAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [unassignBusy, setUnassignBusy] = useState<string | null>(null);
  const [unassignOpen, setUnassignOpen] = useState<string | null>(null);
  const [unassignError, setUnassignError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const me = await request<Me>('/me');
        const mem = selectMembership(me.memberships, organizationId);
        if (!mem) {
          router.push('/app');
          return;
        }
        setCurrentUserId(me.userId);
        setMembership(mem);

        if (!hasPermission(mem, 'organization:update')) {
          setError('You do not have permission to view roles in this organization.');
          setLoading(false);
          return;
        }

        const [roleData, membersData] = await Promise.all([
          request<Role>(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}`),
          request<readonly Member[]>(`/organizations/${encodeURIComponent(organizationId)}/members`),
        ]);

        if (!roleData) {
          router.push(`/app/roles?organization=${encodeURIComponent(organizationId)}`);
          return;
        }

        setRole(roleData);
        setMembers(membersData ?? []);

        const assignmentsData = await request<readonly RoleAssignment[]>(
          `/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}/assignments`,
        );
        setAssignments(assignmentsData ?? []);
      } catch {
        setError('Failed to load role details.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [organizationId, roleId, router]);

  async function confirmUnassign(userId: string) {
    setUnassignBusy(userId);
    setUnassignError('');
    try {
      await ensureCsrfToken();
      await request(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}/assignments/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
      window.location.reload();
    } catch (err) {
      setUnassignError(messageFor(err));
    } finally {
      setUnassignBusy(null);
      setUnassignOpen(null);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Role Details" />
        <p className="notice" role="status">Loading…</p>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Role Details" />
        <p className="notice notice-error">{error}</p>
      </>
    );
  }

  if (!membership || !role) return null;

  const assignedMembers = members.filter((m) => assignments.some((a) => a.userId === m.userId));
  const canManage = hasPermission(membership, 'organization:update');
  const canAssign = hasPermission(membership, 'member:update');
  const isSystem = role.type === 'SYSTEM';

  return (
    <>
      <PageHeader
        title={role.name}
        eyebrow={membership.organizationName}
        description={role.description ?? 'No description provided.'}
        actions={
          !isSystem && canManage && (
            <a
              className="button-secondary"
              href={`/app/roles/${encodeURIComponent(role.id)}/edit?organization=${encodeURIComponent(organizationId)}`}
            >
              Edit role
            </a>
          )
        }
      />

      <div style={{ display: 'grid', gap: '1.5rem', gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <SectionCard title="Role information" style={{ gridColumn: '1 / -1' }}>
          <dl className="details-grid">
            <dt>Name</dt>
            <dd>{role.name}</dd>
            <dt>Type</dt>
            <dd><Tag variant={role.type === 'SYSTEM' ? 'system' : 'custom'}>{role.type}</Tag></dd>
            <dt>Created</dt>
            <dd>{new Date(role.createdAt).toLocaleString()}</dd>
            <dt>Updated</dt>
            <dd>{new Date(role.updatedAt).toLocaleString()}</dd>
            <dt>Assigned members</dt>
            <dd>{role.assignedUserCount}</dd>
          </dl>
        </SectionCard>

        <SectionCard title="Permissions" style={{ gridColumn: '1 / -1' }}>
          <div className="permission-tags">
            {role.permissions.map((p) => (
              <span key={p} className="permission-tag">{permissionLabel(p)}</span>
            ))}
            {role.permissions.length === 0 && <span className="field-hint">No permissions granted</span>}
          </div>
        </SectionCard>

        {!isSystem && canAssign && (
          <SectionCard title="Assignments" style={{ gridColumn: '1 / -1' }}>
            {assignments.length === 0 ? (
              <div className="empty-state">
                <p>No members assigned to this role.</p>
                <a
                  className="button-primary"
                  href={`/app/roles/${encodeURIComponent(role.id)}/assign?organization=${encodeURIComponent(organizationId)}`}
                >
                  Assign member
                </a>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Member</th>
                      <th scope="col">Email</th>
                      <th scope="col">Assigned</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignedMembers.map((member) => {
                      const assignment = assignments.find((a) => a.userId === member.userId);
                      return (
                        <tr key={member.userId}>
                          <td className="email-cell">
                            {member.email}
                            <small>{member.role.replace(/_/g, ' ')}</small>
                          </td>
                          <td>{assignment?.email ?? member.email}</td>
                          <td>{assignment ? new Date(assignment.assignedAt).toLocaleDateString() : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {canAssign && member.userId !== currentUserId && (
                              <UnassignButton
                                userId={member.userId}
                                onConfirm={confirmUnassign}
                                busy={unassignBusy === member.userId}
                                open={unassignOpen === member.userId}
                                onOpen={() => setUnassignOpen(member.userId)}
                                onClose={() => setUnassignOpen(null)}
                                error={unassignError}
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        )}
      </div>
    </>
  );
}

function permissionLabel(permission: string): string {
  return permission.replace(/_/g, ' ').replace(/:/g, ' — ');
}

function UnassignButton({
  userId,
  onConfirm,
  busy,
  open,
  onOpen,
  onClose,
  error,
}: {
  readonly userId: string;
  readonly onConfirm: (userId: string) => void;
  readonly busy: boolean;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly error: string;
}) {
  return (
    <>
      <button type="button" className="button-danger" onClick={onOpen} disabled={busy}>
        Unassign
      </button>
      {open && (
        <ConfirmDialog
          title="Unassign member?"
          message="This will remove the member from this custom role. Their effective permissions will be updated immediately."
          onConfirm={() => onConfirm(userId)}
          onCancel={onClose}
          confirmLabel="Unassign"
          confirmVariant="danger"
          busy={busy}
          error={error}
        />
      )}
    </>
  );
}
