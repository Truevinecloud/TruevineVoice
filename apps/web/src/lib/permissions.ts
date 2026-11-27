/** Presentational permission check shared by client components. */
export function hasPermission(
  membership: { readonly permissions?: readonly string[] } | null | undefined,
  permission: string,
): boolean {
  return membership?.permissions?.includes(permission) ?? false;
}
