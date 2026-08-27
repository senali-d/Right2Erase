const SYSTEM_ALIASES = new Map([
  ['postgres', 'database'],
  ['postgresql', 'database'],
  ['database', 'database'],
  ['db', 'database'],
  ['minio', 'minio'],
  ['storage', 'minio'],
  ['s3', 'minio'],
  ['billing', 'billing'],
]);

/** Return the canonical execution target for a plan system name. */
export function normalizeSystem(system) {
  if (typeof system !== 'string') return null;
  return SYSTEM_ALIASES.get(system.toLowerCase()) || null;
}
