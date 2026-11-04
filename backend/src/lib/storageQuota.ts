import { config } from '../config';
import { getRedis } from '../redis';

// Disk quotas are only real when docker really enforces `--storage-opt size=` (overlay2 on xfs with pquota).
// STORAGE_QUOTA=true is just the administrator's claim. The WORKER proves it at startup with a trial container and
// publishes the result here; the API (which has no Docker access) and the dashboard only believe the proof.
const KEY = 'devflow:storage-quota';
const TTL_SECONDS = 180; // the worker refreshes this every minute; if the worker is down the claim expires

export async function storageQuotaEnforced(): Promise<boolean> {
  if (!config.runtime.storageQuota) return false;
  try {
    return (await getRedis().get(KEY)) === 'verified';
  } catch {
    return false;
  }
}

export const publishStorageQuota = (verified: boolean) =>
  getRedis().set(KEY, verified ? 'verified' : 'unsupported', 'EX', TTL_SECONDS);

// `docker run --storage-opt size=16m ...` either starts (supported) or fails at create time with a message that
// mentions storage-opt (unsupported backing filesystem / driver). Any other failure is "could not prove it".
export function interpretStorageProbe(exitCode: number, output: string): boolean {
  return exitCode === 0 && !/storage-opt|storage driver|pquota/i.test(output);
}
