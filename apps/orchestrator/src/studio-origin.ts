/**
 * Browser origins allowed to call the local orchestrator from the studio UI.
 * Keep this list exact — reflecting an arbitrary Origin is what let any tab
 * on the machine spend the signed-in OpenAI subscription.
 */
export const STUDIO_ORIGINS = [
  "http://localhost:4311",
  "http://127.0.0.1:4311",
  "http://forge.tail5728ca.ts.net:4311",
] as const;

/**
 * Origin policy for the paid prototype ImageGen POST:
 *
 * - Allowlisted studio origins pass (the Vite app and the Tailscale hostname).
 * - Missing Origin passes. This process binds 127.0.0.1 only, and browsers
 *   always attach Origin on a cross-origin POST, so a CSRF page cannot omit
 *   the header. Curl and other local/non-browser clients still work.
 * - `Origin: null` (opaque / sandboxed documents) and any other value fail.
 */
export const isTrustedStudioOrigin = (
  origin: string | string[] | undefined,
): boolean => {
  if (origin === undefined || origin === "") return true;
  if (Array.isArray(origin)) return false;
  return (STUDIO_ORIGINS as readonly string[]).includes(origin);
};
