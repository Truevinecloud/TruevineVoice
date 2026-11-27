'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';

import { ApiError, ensureCsrfToken, request } from '../../../../../lib/api';
import type { Me, MembershipSummary } from '../../../../../lib/session';
import { selectMembership } from '../../../../../lib/organization-context';
import { hasPermission } from '../../../../../lib/permissions';
import type { Member, Role, RoleAssignment } from '../../../../../lib/role-types';
import { PageHeader, SectionCard, Button } from '../../../AppUI';

export default function AssignRolePage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const roleId = params.roleId as string;
  const organizationId = searchParams.get('organization') ?? '';

  const [membership, setMembership] = useState<MembershipSummary | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [assignments, setAssignments] = useState<readonly RoleAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedUserId, setSelectedUserId] = useState('');
  const [busy, setBusy] = useState(false);

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
        setMembership(mem);

        if (!hasPermission(mem, 'member:update')) {
          setError('You do not have permission to assign roles in this organization.');
          setLoading(false);
          return;
        }

        const [roleData, membersData] = await Promise.all([
          request<Role>(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}`),
          request<readonly Member[]>(`/organizations/${encodeURIComponent(organizationId)}/members`),
        ]);

        if (!roleData || roleData.type === 'SYSTEM') {
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
        setError('Failed to load role.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [organizationId, roleId, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);

    if (!selectedUserId) {
      setError('Please select a member to assign.');
      setBusy(false);
      return;
    }

    try {
      await ensureCsrfToken();
      await request(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}/assignments`, {
        method: 'POST',
        body: { userId: selectedUserId },
      });
      router.push(`/app/roles/${encodeURIComponent(roleId)}?organization=${encodeURIComponent(organizationId)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign role.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Assign Role" />
        <p className="notice" role="status">Loading…</p>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Assign Role" />
        <p className="notice notice-error">{error}</p>
      </>
    );
  }

  if (!membership || !role) return null;

  const assignedUserIds = new Set(assignments.map((a) => a.userId));
  const availableMembers = members.filter((m) => !assignedUserIds.has(m.userId));

  // Presentational only; the API re-checks delegation on assignment.
  const actorPermissions = new Set<string>(membership.permissions);
  const rolePermissions = role.permissions;
  const canDelegateRole =
    rolePermissions.every((p) => actorPermissions.has(p)) && rolePermissions.length < actorPermissions.size;

  if (!canDelegateRole) {
    return (
      <>
        <PageHeader title="Assign Role" />
        <p className="notice notice-error">You cannot assign this role because its permissions exceed your delegation scope.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Assign Role"
        eyebrow={membership.organizationName}
        description={`Assign "${role.name}" to a team member.`}
      />
      <form onSubmit={handleSubmit} className="card" style={{ maxWidth: '560px' }}>
        <SectionCard title="Select member">
          {availableMembers.length === 0 ? (
            <div className="empty-state">
              <p>All eligible members already have this role.</p>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="userId">Member <span className="required">*</span></label>
              <select
                id="userId"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="select"
                disabled={busy}
                required
              >
                <option value="">Choose a member</option>
                {availableMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email} — {member.role.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
          )}
        </SectionCard>

        <div className="button-row" style={{ marginTop: '1.5rem' }}>
          <Button type="submit" variant="primary" disabled={busy || !selectedUserId}>
            {busy ? 'Assigning…' : 'Assign role'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </>
  );
}
