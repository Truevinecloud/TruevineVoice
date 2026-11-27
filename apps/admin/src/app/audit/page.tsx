import { RouteAlias } from '../route-alias';

/** Compatibility alias for the platform audit workspace URL. */
export default function AuditAliasPage() {
  return <RouteAlias href="/auditor" label="audit workspace" />;
}
