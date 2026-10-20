/** Exact-origin CORS allowlist. Missing Origin is allowed for native clients. */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin.length === 0) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

export function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))];
}
