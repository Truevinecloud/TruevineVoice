/**
 * `@truevine/ui` — Shared design-system components for Truevine Voice.
 *
 * Framework-agnostic React components used by `apps/web` (customer) and
 * `apps/admin` (platform administrator). Each component is a thin, accessible
 * React wrapper over semantic CSS classes defined in `design-tokens.css` and
 * each app's own `globals.css`. No UI framework or CSS-in-JS dependency is
 * introduced.
 *
 * Components are intentionally primitive: they handle structure, keyboard
 * interaction, focus management and ARIA. Visual theming (colors, spacing,
 * borders) comes from CSS custom properties so each app can theme
 * independently while sharing the same component semantics.
 */

export * from './design-tokens.css';
export * from './Button.js';
export * from './Input.js';
export * from './Select.js';
export * from './Checkbox.js';
export * from './Table.js';
export * from './Card.js';
export * from './Badge.js';
export * from './Modal.js';
export * from './Notification.js';
export * from './Loading.js';
export * from './EmptyState.js';
export * from './ErrorState.js';
export * from './ConfirmationDialog.js';
export * from './Pagination.js';
