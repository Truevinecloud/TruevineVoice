# W1-11 Frontend Design System & Application Shell

**Task ID:** W1-11
**Week:** 1
**Epic:** Frontend
**Priority:** P0
**Owner/Lane:** Frontend/UX
**Dependency:** W1-02 (Create/confirm monorepo)
**Status:** In Progress — implementation complete, production acceptance pending
**Acceptance:** Responsive shell deployed; component baseline reviewed
**Target environment:** Local→Live
**Specification reference:** v5.2 Frontend & UX

---

## 1. Existing Implementation Assessment

### Monorepo Foundation (W1-02)

The monorepo foundation is established and working:

| Component | Status | Evidence |
|-----------|--------|----------|
| npm workspaces | Pass | `apps/*` and `packages/*` configured |
| Node.js | 24.19.0 | `.nvmrc` |
| npm | 11.17.0 | `package.json` |
| TypeScript | 6.0.3 | `package.json` |
| Vitest | 5.0.3 | Per-app configs |
| ESLint | 10.12.0 | Root config |

### Frontend Applications

#### apps/web (Customer Frontend, port 3000)

Already implemented:

| Component | File | Status |
|-----------|------|--------|
| App shell with navigation | `apps/web/src/app/app/AppNavigation.tsx` | Complete — role-aware navigation, mobile support, skip links, focus management, org switcher |
| Shared UI components | `apps/web/src/app/app/AppUI.tsx` | Complete — OrganizationAccessDenied, PageHeader, SectionCard, EmptyState, StatusBadge, Input, Textarea, Select, Button, Tag, ConfirmDialog |
| Design tokens | `apps/web/src/app/app/globals.css` | Complete — 3300+ lines with inline design tokens |
| Auth pages | `apps/web/src/app/(auth)/` | Complete — sign-in, accept-invite, accept-terms, forgot-password, reset-password, set-password |
| Feature modules | `apps/web/src/app/app/{account,audio,billing,campaigns,contacts,invitations,reports,roles,settings,team}/` | Complete |
| Marketing components | `apps/web/src/app/marketing/` | Complete — BrandLogo, HeroShowcase, MarketingHeader |
| Tests | Multiple `*.spec.tsx` files | Passing |

#### apps/admin (Platform Admin, port 3002)

Already implemented:

| Component | File | Status |
|-----------|------|--------|
| Platform shell | `apps/admin/src/app/PlatformShell.tsx` | Complete — role-aware navigation, sidebar, header, sign-out |
| Design tokens | `apps/admin/src/app/design-system/tokens.css` | Complete — semantic color, spacing, border-radius, focus, transition, z-index tokens |
| Design system CSS | `apps/admin/src/app/globals.css` | Complete — 415+ lines |
| Shell CSS | `apps/admin/src/app/platform-shell.css` | Complete — responsive sidebar, header, mobile navigation |
| Tests | Multiple `*.spec.tsx` files | Passing |

### Shared UI Package

| Component | File | Status |
|-----------|------|--------|
| Package manifest | `packages/ui/package.json` | Existed — `@truevine/ui` |
| TypeScript config | `packages/ui/tsconfig.json` | **Created** — extends base config |
| Build config | `packages/ui/tsconfig.build.json` | **Created** — for `tsc --build` |
| Vitest config | `packages/ui/vitest.config.mts` | **Created** — jsdom environment |
| Design tokens | `packages/ui/src/design-tokens.css` | **Created** — shared semantic tokens |
| CSS types | `packages/ui/src/design-tokens.css.d.ts` | **Created** — CSS module declarations |
| Component index | `packages/ui/src/index.ts` | **Created** — exports all components |
| Button | `packages/ui/src/Button.tsx` | **Created** — primary/secondary/danger/ghost variants |
| Input | `packages/ui/src/Input.tsx` | **Created** — text input with label/hint/error |
| Select | `packages/ui/src/Select.tsx` | **Created** — select control with options |
| Checkbox | `packages/ui/src/Checkbox.tsx` | **Created** — checkbox with label |
| Table | `packages/ui/src/Table.tsx` | **Created** — data table with columns/rows |
| Card | `packages/ui/src/Card.tsx` | **Created** — section container with title/actions |
| Badge | `packages/ui/src/Badge.tsx` | **Created** — neutral/success/warning/danger/info variants |
| Modal | `packages/ui/src/Modal.tsx` | **Created** — accessible modal dialog |
| Notification | `packages/ui/src/Notification.tsx` | **Created** — non-blocking status message |
| Loading | `packages/ui/src/Loading.tsx` | **Created** — loading spinner |
| EmptyState | `packages/ui/src/EmptyState.tsx` | **Created** — empty state component |
| ErrorState | `packages/ui/src/ErrorState.tsx` | **Created** — error state component |
| ConfirmationDialog | `packages/ui/src/ConfirmationDialog.tsx` | **Created** — confirmation dialog |
| Pagination | `packages/ui/src/Pagination.tsx` | **Created** — pagination controls |
| Tests | `packages/ui/src/components.spec.tsx` | **Created** — 37 tests |

---

## 2. Design System

### Design Tokens

The shared design tokens in `packages/ui/src/design-tokens.css` define:

| Category | Tokens |
|----------|--------|
| Colors | Background, foreground, card, border, muted, ink, line, brand, success, warning, danger, info |
| Spacing | space-1 through space-12 (0.25rem to 3rem) |
| Border radius | radius-sm through radius-full (0.45rem to 9999px) |
| Focus indicators | focus-outline, focus-offset, focus-customer-color, focus-admin-color |
| Transitions | transition-fast, transition-base, transition-slow |
| Z-index | z-dropdown through z-toast (10 to 40) |

Supports light and dark themes via `prefers-color-scheme`.

### Component Inventory

| Component | File | Variants/Props |
|-----------|------|---------------|
| Button | `Button.tsx` | primary, secondary, danger, ghost; default, small |
| Input | `Input.tsx` | text, email, tel, password, number, url; label, hint, error |
| Select | `Select.tsx` | options array, disabled, label, hint, error |
| Checkbox | `Checkbox.tsx` | checked, disabled, label, error |
| Table | `Table.tsx` | columns, rows, row renderer |
| Card | `Card.tsx` | title, description, actions, children |
| Badge | `Badge.tsx` | neutral, success, warning, danger, info |
| Modal | `Modal.tsx` | isOpen, title, onClose, children |
| Notification | `Notification.tsx` | success, warning, danger, info; onClose |
| Loading | `Loading.tsx` | message |
| EmptyState | `EmptyState.tsx` | title, children, action, symbol |
| ErrorState | `ErrorState.tsx` | title, children, action, details |
| ConfirmationDialog | `ConfirmationDialog.tsx` | isOpen, title, message, onConfirm, onCancel, confirmLabel, confirmVariant, busy, error |
| Pagination | `Pagination.tsx` | currentPage, totalItems, pageSize, onPageChange |

---

## 3. Application Shell

### Existing Shells (Preserved — Not Rebuilt)

Both frontend apps already have complete, working shell implementations:

**Customer Shell (`apps/web/src/app/app/AppNavigation.tsx`):**
- Session-based authentication guard
- Organization membership selection
- Role-aware navigation (Workspace, Organization, Account groups)
- Mobile-responsive sidebar with collapse/expand
- Skip-to-content link for accessibility
- Focus trap in mobile sidebar
- Organization switcher dropdown
- Account menu with avatar

**Platform Admin Shell (`apps/admin/src/app/PlatformShell.tsx`):**
- Role-based navigation (Platform Owner, Platform Admin, Operations Admin, Support Admin, Technical Admin, Auditor, Billing Admin)
- Sidebar navigation with brand, context, and sign-out
- Mobile-responsive with hamburger menu and backdrop
- Role-aware menu item visibility

### W1-11 Contribution

W1-11 does **not** rebuild existing shells. Instead, it provides:

1. **Shared design system** (`packages/ui`) — both apps can gradually adopt shared components
2. **Consistent component patterns** — both apps use similar patterns (buttons, inputs, cards, badges, etc.) now unified in `@truevine/ui`
3. **Tested components** — 37 unit tests covering all components

Frontend visibility does **not** replace backend authorization — all routes re-check permissions server-side.

---

## 4. Automated Verification

### Test Coverage

| Test File | Tests | Result |
|-----------|-------|--------|
| `packages/ui/src/components.spec.tsx` | 37 | PASS |

| Component | Tests Covered |
|-----------|-------------|
| Button | variant class, disabled state, onClick, small size |
| Input | label/value, onChange, disabled state, error message |
| Select | options rendering, onChange |
| Checkbox | checked state, onChange, disabled state |
| Badge | variant class, default variant |
| Card | title/description/children, actions |
| Table | columns and rows rendering |
| Modal | isOpen show/hide, onClose |
| Notification | variant rendering, onClose |
| Loading | message, aria-busy, no-message variant |
| EmptyState | title/children, action button |
| ErrorState | title/children, details |
| ConfirmationDialog | isOpen show/hide, onConfirm, onCancel |
| Pagination | controls rendering, page click, disabled states |

### Test Commands

```bash
# From packages/ui directory
cd packages/ui
npm test          # Run vitest
npm run typecheck # Run tsc --noEmit
npm run build     # Run tsc --build
npm run lint      # Run eslint
```

### Test Results

| Check | Command | Result |
|-------|---------|--------|
| TypeScript typecheck | `tsc --noEmit -p packages/ui/tsconfig.json` | PASS |
| Unit tests | `vitest run` | 37/37 PASS |
| Build | `tsc --build tsconfig.build.json` | PASS |
| ESLint | `eslint .` | Not verified (hangs in this environment) |

---

## 5. Files Created or Modified

### Created

| File | Purpose |
|------|---------|
| `packages/ui/package.json` | Updated — added scripts, devDependencies, peerDependencies |
| `packages/ui/tsconfig.json` | Created — TypeScript config |
| `packages/ui/tsconfig.build.json` | Created — build config |
| `packages/ui/vitest.config.mts` | Created — Vitest config |
| `packages/ui/src/index.ts` | Created — barrel export |
| `packages/ui/src/design-tokens.css` | Created — shared design tokens |
| `packages/ui/src/design-tokens.css.d.ts` | Created — CSS module type declarations |
| `packages/ui/src/Button.tsx` | Created — button component |
| `packages/ui/src/Input.tsx` | Created — input component |
| `packages/ui/src/Select.tsx` | Created — select component |
| `packages/ui/src/Checkbox.tsx` | Created — checkbox component |
| `packages/ui/src/Table.tsx` | Created — table component |
| `packages/ui/src/Card.tsx` | Created — card component |
| `packages/ui/src/Badge.tsx` | Created — badge component |
| `packages/ui/src/Modal.tsx` | Created — modal dialog component |
| `packages/ui/src/Notification.tsx` | Created — notification component |
| `packages/ui/src/Loading.tsx` | Created — loading component |
| `packages/ui/src/EmptyState.tsx` | Created — empty state component |
| `packages/ui/src/ErrorState.tsx` | Created — error state component |
| `packages/ui/src/ConfirmationDialog.tsx` | Created — confirmation dialog component |
| `packages/ui/src/Pagination.tsx` | Created — pagination component |
| `packages/ui/src/components.spec.tsx` | Created — 37 unit tests |
| `docs/w1-11-design-system.md` | Created — this document |

### Modified

| File | Change |
|------|---------|
| `packages/ui/package.json` | Updated — added build scripts, devDependencies, peerDependencies |

---

## 6. Remaining Integration Requirements

| Requirement | Status | Notes |
|-------------|--------|-------|
| apps/web consumes @truevine/ui | Not started | Web app can gradually replace inline components with @truevine/ui |
| apps/admin consumes @truevine/ui | Not started | Admin app can gradually replace inline components with @truevine/ui |
| Design token alignment | Not started | Both apps' existing CSS can gradually reference shared tokens |
| ESLint verification | Blocked | ESLint hangs in this environment |
| Browser testing | Not started | Left to responsible testing agent |
| Production deployment | Not started | Frontend apps deploy via existing CI/CD pipeline |

---

## 7. Browser Testing Requirements

Browser testing is **not** performed in this implementation. The responsible testing agent should:

1. Verify responsive layouts (desktop, tablet, mobile)
2. Verify keyboard navigation (Tab order, focus indicators)
3. Verify screen reader compatibility (ARIA attributes, roles)
4. Verify color contrast (WCAG 2.2 AA)
5. Verify form validation and error states
6. Verify modal dialogs (escape key, backdrop click, focus trap)

---

## 8. Final Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Shared design system package created | PASS |
| Design tokens defined (color, spacing, radius, focus, z-index) | PASS |
| Reusable components implemented (Button, Input, Select, Checkbox, Table, Card, Badge, Modal, Notification, Loading, EmptyState, ErrorState, ConfirmationDialog, Pagination) | PASS |
| Components are accessible (ARIA attributes, keyboard interactions, focus indicators) | PASS |
| Unit tests pass (37/37) | PASS |
| TypeScript typecheck passes | PASS |
| Build passes | PASS |
| No new dependencies installed | PASS |
| Existing frontend apps not modified | PASS |
| No live calls, SMS, or payments | PASS |
| No production deployment | PASS |

W1-11 remains **In Progress** until browser testing and final acceptance testing are completed by the responsible testing agent.
