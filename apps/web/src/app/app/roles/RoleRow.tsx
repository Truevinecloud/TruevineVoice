'use client';

import { useState } from 'react';
import { ensureCsrfToken, messageFor, request } from '../../../lib/api';
import { Tag, ConfirmDialog } from '../AppUI';

export interface RoleRowProps {
  readonly role: { readonly id: string; readonly name: string; readonly description: string | null; readonly type: 'SYSTEM' | 'CUSTOM'; readonly permissions: readonly string[]; readonly assignedUserCount: number };
  readonly organizationId: string;
}

function permissionLabel(permission: string): string {
  return permission.replace(/_/g, ' ').replace(/:/g, ' — ');
}

export function RoleRow({ role, organizationId }: RoleRowProps) {
  const isSystem = role.type === 'SYSTEM';
  const canEdit = !isSystem;
  const canDelete = !isSystem && role.assignedUserCount === 0;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  async function confirmDelete() {
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await ensureCsrfToken();
      await request(`/organizations/${encodeURIComponent(organizationId)}/roles/${encodeURIComponent(role.id)}`, {
        method: 'DELETE',
      });
      window.location.reload();
    } catch (err) {
      setDeleteError(messageFor(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <tr>
      <td className="email-cell">
        {role.name}
        {role.description && <small>{role.description}</small>}
      </td>
      <td><Tag variant={isSystem ? 'system' : 'custom'}>{role.type}</Tag></td>
      <td>
        <div className="permission-tags">
          {role.permissions.slice(0, 4).map((p) => (
            <span key={p} className="permission-tag">{permissionLabel(p)}</span>
          ))}
          {role.permissions.length > 4 && (
            <span className="permission-tag more">+{role.permissions.length - 4} more</span>
          )}
        </div>
      </td>
      <td>{role.assignedUserCount}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <a
          className="button-secondary"
          href={`/app/roles/${encodeURIComponent(role.id)}?organization=${encodeURIComponent(organizationId)}`}
          style={{ marginRight: '0.5rem' }}
        >
          View
        </a>
        {canEdit && (
          <a
            className="button-secondary"
            href={`/app/roles/${encodeURIComponent(role.id)}/edit?organization=${encodeURIComponent(organizationId)}`}
            style={{ marginRight: '0.5rem' }}
          >
            Edit
          </a>
        )}
        {canDelete && (
          <>
            <button
              type="button"
              className="button-danger"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteBusy}
            >
              Delete
            </button>
            {deleteOpen && (
              <ConfirmDialog
                title={`Delete "${role.name}"?`}
                message="This role will be permanently deleted. This action cannot be undone. Make sure no users are assigned to this role."
                onConfirm={confirmDelete}
                onCancel={() => setDeleteOpen(false)}
                confirmLabel="Delete role"
                confirmVariant="danger"
                busy={deleteBusy}
                error={deleteError}
              />
            )}
          </>
        )}
      </td>
    </tr>
  );
}