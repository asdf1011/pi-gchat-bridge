/**
 * Allow-list matching for Google resource names.
 *
 * Values on each side may be the full resource name (`spaces/abc`, `users/123`)
 * or just the trailing ID. An empty allow-list means "allow everyone".
 */
export function isAllowed(value: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (!value) return false;
  const id = value.split("/").pop() ?? value;
  return allowed.some((entry) => {
    const entryId = entry.split("/").pop() ?? entry;
    return value === entry || value === entryId || id === entry || id === entryId;
  });
}
