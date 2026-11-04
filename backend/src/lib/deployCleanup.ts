// What must be undone when a deployment attempt ends, whatever the way it ended (success, failure, timeout, cancel).
// Pure orchestration over injected I/O so every path can be tested without Docker.
export type CleanupIO = {
  removeContainer: (name: string) => Promise<void>;
  removePath: (p: string) => Promise<void>;
  clearCancelFlag: () => Promise<void>;
};

export type CleanupInput = {
  candidateContainer: string | null; // the container started for this attempt
  switched: boolean; // traffic already moved to it: then it is the live version and must stay
  paths: string[]; // work dir, env file (secrets!), image tarball
  failed: boolean; // anything but success
};

export async function cleanupDeployment(i: CleanupInput, io: CleanupIO): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); // keep going: one failure must not skip the rest
    }
  };
  if (i.candidateContainer && !i.switched) await attempt(`remove container ${i.candidateContainer}`, () => io.removeContainer(i.candidateContainer!));
  for (const p of i.paths) await attempt(`remove ${p}`, () => io.removePath(p));
  await attempt('clear cancel flag', io.clearCancelFlag);
  return errors;
}

// How did the attempt end? Used for the final status and the message.
export type EndReason = 'cancelled' | 'timeout' | 'failed';

export class DeployCancelled extends Error {}
export class DeployTimeout extends Error {}

export function classifyFailure(err: unknown): EndReason {
  if (err instanceof DeployCancelled) return 'cancelled';
  if (err instanceof DeployTimeout) return 'timeout';
  return 'failed';
}
