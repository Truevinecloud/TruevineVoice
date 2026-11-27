/* ==========================================================================
   Type declarations for CSS modules.
   ========================================================================== */

declare module '*.css' {
  const classes: { [key: string]: string };
  export default classes;
}
