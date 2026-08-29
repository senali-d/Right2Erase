import * as Minio from 'minio';
import { hashPlan } from './plan.js';
import { normalizeSystem } from './system.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function createSandboxMinioClient({
  endPoint = process.env.MINIO_HOST || 'localhost',
  port = Number(process.env.MINIO_PORT || 9000),
  useSSL = process.env.MINIO_USE_SSL === 'true',
  accessKey = process.env.MINIO_ACCESS_KEY || 'shopkart',
  secretKey = process.env.MINIO_SECRET_KEY || 'shopkart123',
} = {}) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('MinIO deletion client is sandbox-only');
  if (!LOCAL_HOSTS.has(endPoint))
    throw new Error('refusing non-local MinIO target');
  return new Minio.Client({ endPoint, port, useSSL, accessKey, secretKey });
}

/**
 * The only destructive MinIO operation in the application.
 *
 * This executor deliberately receives an already approved plan and a result
 * from the PostgreSQL phase. It does not discover objects or accept an
 * arbitrary list of keys, so a caller cannot turn the read-only storage
 * adapter into a delete API by accident.
 */
export async function executeSandboxMinioDeletion({
  plan,
  planHash,
  approval,
  postgresPhase,
  client,
  bucket = 'shopkart-uploads',
  withheld = [],
  objects: requestedObjects,
  objectKeys,
}) {
  validateExecution({
    plan,
    planHash,
    approval,
    postgresPhase,
    client,
    bucket,
    objects: requestedObjects,
    objectKeys,
  });
  const objects = objectActions(plan);
  const withheldKeys = new Set(
    withheld.map((item) => objectKey(item?.locator ?? item)).filter(Boolean),
  );

  // Validate every target before the first delete. In particular, a withheld
  // key must never result in a partial destructive execution.
  for (const object of objects) {
    if (withheldKeys.has(object.key))
      throw new Error(`refusing withheld object: ${object.key}`);
  }

  const results = [];
  for (const object of objects) {
    try {
      await client.removeObject(bucket, object.key);
      results.push({ key: object.key, status: 'deleted' });
    } catch (error) {
      results.push({ key: object.key, status: 'failed', error: error.message });
    }
  }

  return {
    plan_hash: planHash,
    bucket,
    results,
    counts: {
      requested: objects.length,
      deleted: results.filter((result) => result.status === 'deleted').length,
      failed: results.filter((result) => result.status === 'failed').length,
    },
  };
}

function validateExecution({
  plan,
  planHash,
  approval,
  postgresPhase,
  client,
  bucket,
  objects,
  objectKeys,
}) {
  if (objects !== undefined || objectKeys !== undefined) {
    throw new Error('object targets must come from the approved plan');
  }
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.actions)) {
    throw new Error('an approved plan with actions is required');
  }
  if (typeof planHash !== 'string' || hashPlan(plan) !== planHash) {
    throw new Error('plan hash does not match the supplied plan');
  }
  const hasApproval =
    approval &&
    approval.plan_hash === planHash &&
    (approval.approved === true || typeof approval.approved_by === 'string');
  if (!hasApproval) throw new Error('the plan must have matching approval');
  if (!postgresPhase || postgresPhase.success !== true) {
    throw new Error('MinIO deletion requires a successful PostgreSQL phase');
  }
  if (!client || typeof client.removeObject !== 'function')
    throw new Error('a MinIO client is required');
  if (typeof bucket !== 'string' || bucket.length === 0)
    throw new Error('a sandbox bucket is required');
}

function objectActions(plan) {
  const seen = new Set();
  return plan.actions
    .filter(
      (action) =>
        normalizeSystem(action?.system) === 'minio' &&
        action.disposition === 'erase',
    )
    .map((action) => {
      const key = objectKey(action.locator);
      if (!key)
        throw new Error(
          'MinIO erase action must explicitly name an object key',
        );
      if (seen.has(key))
        throw new Error(`duplicate MinIO object in plan: ${key}`);
      seen.add(key);
      return { key };
    });
}

function objectKey(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object')
    return value.key || value.object_key || null;
  return null;
}

export { objectActions };
