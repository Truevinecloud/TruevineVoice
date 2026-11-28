'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, ensureCsrfToken, request } from '../../../../lib/api';
import { ROLE_CATEGORIES } from '../role-categories';
import { PageHeader, SectionCard, Button, Input, Textarea } from '../../AppUI';

export function CreateRoleForm({
  organizationId,
  organizationName,
  delegablePermissions,
}: {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly delegablePermissions: readonly string[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function togglePermission(permission: string) {
    setPermissions((prev) => prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission]);
  }

  function selectCategory(categoryPermissions: readonly string[]) {
    setPermissions((prev) => [...new Set([...prev, ...categoryPermissions.filter((p) => delegablePermissions.includes(p))])]);
  }

  function clearCategory(categoryPermissions: readonly string[]) {
    setPermissions((prev) => prev.filter((p) => !categoryPermissions.includes(p)));
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
      const response = await request<{ id: string }>(`/organizations/${encodeURIComponent(organizationId)}/roles`, {
        method: 'POST',
        body: { name: trimmedName, description: description.trim() || null, permissions },
      });
      router.push(`/app/roles/${encodeURIComponent(response.id)}?organization=${encodeURIComponent(organizationId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'role_name_conflict') {
        setError('A role with this name already exists.');
      } else if (err instanceof ApiError && err.isForbidden) {
        setError('You do not have permission to create this role.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to create role. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Create Custom Role"
        eyebrow={organizationName}
        description="Define a new role with a custom set of permissions. You can only grant permissions you yourself hold."
      />
      {error && <p className="notice notice-error" role="alert">{error}</p>}
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
              disabled={busy}
            />
          ))}
        </SectionCard>

        <div className="button-row" style={{ marginTop: '1.5rem' }}>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create role'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>
            Cancel
          </Button>
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
  disabled,
}: {
  readonly category: { readonly key: string; readonly label: string; readonly permissions: readonly string[] };
  readonly permissions: readonly string[];
  readonly delegablePermissions: readonly string[];
  readonly onToggle: (permission: string) => void;
  readonly onSelectAll: () => void;
  readonly onClearAll: () => void;
  readonly disabled: boolean;
}) {
  const availablePermissions = category.permissions.filter((p) => delegablePermissions.includes(p));

  if (availablePermissions.length === 0) return null;

  const isSelected = availablePermissions.every((permission) => permissions.includes(permission));
  const isPartial = !isSelected && availablePermissions.some((permission) => permissions.includes(permission));

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
