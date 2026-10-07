# @truevine/ui

Reserved for shared, framework-agnostic UI primitives used by `apps/web` and
`apps/admin`.

**Status: intentionally empty.** No component library, design token set or CSS
framework has been chosen. Adding one now would be speculative; the two
frontends currently ship hand-written CSS so that the foundation has no styling
dependencies to unpick later.

When this package is populated, remember that `apps/admin` is a separate
internal surface and must not be forced to consume customer-facing components.
