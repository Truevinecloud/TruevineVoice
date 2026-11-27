'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';

import { ApiError, ensureCsrfToken, request } from '../../../../../lib/api';
import type { Me, MembershipSummary } from '../../../../../lib/session';
import { selectMembership } from '../../../../../lib/organization-context';
import { hasPermission } from '../../../../../lib/permissions';
import { ORGANIZATION_ROLE_PERMISSIONS, type OrganizationRole } from '@truevine/auth';
import { ROLE_CATEGORIES } from '../../role-categories';
import type { Role } from '../../../../../lib/role-types';
import { PageHeader, SectionCard, Button, Input, Textarea, ConfirmDialog } from '../../../AppUI';

export default function EditRolePage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const roleId = params.roleId as string;
  const organizationId = searchParams.get('organization') ?? '';

  const [membership, setMembership] = useState<MembershipSummary | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [delegablePermissions, setDelegablePermissions] = useState<string[]>([]);

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

        if (!hasPermission(mem, 'organization:update')) {
          setError('You do not have permission to edit roles in this organization.');
          setLoading(false);
          return;
        }

        const actorPermissions = ORGANIZATION_ROLE_PERMISSIONS[mem.role as OrganizationRole] ?? [];
        const allActorPermissions = [...new Set([...actorPermissions, ...(mem.permissions ?? [])])];
        setDelegablePermissions(allActorPermissions);

        const roleData = await request<Role>(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}`);
        if (!roleData || roleData.type === 'SYSTEM') {
          router.push(`/app/roles?organization=${encodeURIComponent(organizationId)}`);
          return;
        }
        setRole(roleData);
        setName(roleData.name);
        setDescription(roleData.description ?? '');
        setPermissions([...roleData.permissions]);
      } catch {
        setError('Failed to load role.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [organizationId, roleId, router]);

  function togglePermission(permission: string) {
    setPermissions((prev) => prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission]);
  }

  function selectCategory(categoryPermissions: readonly string[]) {
    setPermissions((prev) => [...new Set([...prev, ...categoryPermissions.filter((p) => delegablePermissions.includes(p))])]);
  }

  function clearCategory(categoryPermissions: readonly string[]) {
    setPermissions((prev) => prev.filter((p) => !categoryPermissions.includes(p)));
  }

  function isCategorySelected(categoryPermissions: readonly string[]) {
    return categoryPermissions.every((p) => permissions.includes(p));
  }

  function isCategoryPartiallySelected(categoryPermissions: readonly string[]) {
    return categoryPermissions.some((p) => permissions.includes(p)) && !isCategorySelected(categoryPermissions);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Role name is required.');
      setBusy(false);
      return;
    }
    if (trimmedName.length > 120) {
      setError('Role name must be 120 characters or fewer.');
      setBusy(false);
      return;
    }

    try {
      await ensureCsrfToken();
      await request(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}`, {
        method: 'PATCH',
        body: { name: trimmedName, description: description.trim() || null, permissions },
      });
      router.push(`/app/roles/${encodeURIComponent(roleId)}?organization=${encodeURIComponent(organizationId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'role_name_conflict') {
        setError('A role with this name already exists.');
      } else if (err instanceof ApiError && err.isForbidden) {
        setError('You do not have permission to edit this role.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to update role. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setError('');
    setDeleteBusy(true);
    try {
      await ensureCsrfToken();
      await request(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(roleId)}`, {
        method: 'DELETE',
      });
      router.push(`/app/roles?organization=${encodeURIComponent(organizationId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'role_assigned') {
        setDeleteError('Cannot delete a role that is assigned to users. Unassign users first.');
      } else if (err instanceof ApiError && err.isForbidden) {
        setDeleteError('You do not have permission to delete this role.');
      } else {
        setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete role. Please try again.');
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Edit Role" />
        <p className="notice" role="status">Loading…</p>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Edit Role" />
        <p className="notice notice-error">{error}</p>
      </>
    );
  }

  if (!membership || !role) return null;

  return (
    <>
      <PageHeader
        title="Edit Role"
        eyebrow={membership.organizationName}
        description={`Modify "${role.name}". System roles cannot be edited.`}
      />
      <form onSubmit={handleSubmit} className="card" style={{ maxWidth: '720px' }}>
        <SectionCard title="Basic information">
          <div className="field">
            <label htmlFor="name">Role name <span className="required">*</span></label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Content Manager"
              maxLength={120}
              required
              disabled={busy}
            />
            <p className="field-hint">A unique name for this role within your organization.</p>
          </div>
          <div className="field">
            <label htmlFor="description">Description</label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this role for? Who should be assigned to it?"
              rows={3}
              disabled={busy}
            />
          </div>
        </SectionCard>

        <SectionCard title="Permissions">
          <p className="field-hint">
            Select the permissions this role grants. You can only grant permissions you hold.
            {delegablePermissions.length === 0 && ' You currently hold no delegable permissions.'}
          </p>
          {ROLE_CATEGORIES.map((category) => (
            <PermissionCategory
              key={category.key}
              category={category}
              permissions={permissions}
              delegablePermissions={delegablePermissions}
              onToggle={togglePermission}
              onSelectAll={() => selectCategory(category.permissions)}
              onClearAll={() => clearCategory(category.permissions)}
              isSelected={isCategorySelected(category.permissions)}
              isPartial={isCategoryPartiallySelected(category.permissions)}
              disabled={busy}
            />
          ))}
        </SectionCard>

        <div className="button-row" style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'space-between' }}>
          <div>
            <Button type="button" variant="danger" onClick={() => setDeleteOpen(true)} disabled={deleteBusy}>
              {deleteBusy ? 'Deleting…' : 'Delete role'}
            </Button>
            {deleteOpen && (
              <ConfirmDialog
                title={`Delete "${role.name}"?`}
                message="This role will be permanently deleted. This action cannot be undone. Make sure no users are assigned to this role."
                onConfirm={handleDelete}
                onCancel={() => setDeleteOpen(false)}
                confirmLabel="Delete role"
                confirmVariant="danger"
                busy={deleteBusy}
                error={deleteError}
              />
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}

function PermissionCategory({
  category,
  permissions,
  delegablePermissions,
  onToggle,
  onSelectAll,
  onClearAll,
  isSelected,
  isPartial,
  disabled,
}: {
  readonly category: { readonly key: string; readonly label: string; readonly permissions: readonly string[] };
  readonly permissions: readonly string[];
  readonly delegablePermissions: readonly string[];
  readonly onToggle: (permission: string) => void;
  readonly onSelectAll: () => void;
  readonly onClearAll: () => void;
  readonly isSelected: boolean;
  readonly isPartial: boolean;
  readonly disabled: boolean;
}) {
  const availablePermissions = category.permissions.filter((p) => delegablePermissions.includes(p));

  if (availablePermissions.length === 0) return null;

  return (
    <fieldset className="permission-category" disabled={disabled}>
      <legend>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={isSelected}
            aria-checked={isPartial ? 'mixed' : isSelected}
            onChange={(e) => (e.target.checked ? onSelectAll() : onClearAll())}
            disabled={disabled}
            aria-label={`Select all ${category.label} permissions`}
          />
          <span>{category.label}</span>
        </label>
      </legend>
      <div className="permission-list">
        {availablePermissions.map((permission) => (
          <label key={permission} className="permission-item">
            <input
              type="checkbox"
              checked={permissions.includes(permission)}
              onChange={() => onToggle(permission)}
              disabled={disabled || !delegablePermissions.includes(permission)}
            />
            <span className="permission-name">{permissionLabel(permission)}</span>
            {!delegablePermissions.includes(permission) && (
              <span className="permission-hint">(not in your scope)</span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function permissionLabel(permission: string): string {
  return permission.replace(/_/g, ' ').replace(/:/g, ' — ');
}
