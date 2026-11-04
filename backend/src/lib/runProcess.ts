import { spawn } from 'child_process';
import { stat } from 'fs/promises';

// Run one child process with a hard deadline, cancellation and an optional output-file size cap.
// The child is started in its OWN PROCESS GROUP and the whole group is killed, so helpers it spawned
// (git-remote-https, shells, a build tool's workers) die with it instead of being orphaned.
export type RunOutcome = 'ok' | 'failed' | 'cancelled' | 'timeout' | 'too-large';

export type RunOptions = {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number; // already min(per-command limit, time left in the deployment)
  isCancelled?: () => Promise<boolean>;
  cancelPollMs?: number;
  // Kill the process when this file grows past maxBytes (e.g. the exported image tarball).
  watchFile?: { path: string; maxBytes: number };
  watchPollMs?: number;
  onOutput?: (chunk: string) => void;
};

export type RunResult = { outcome: RunOutcome; code: number | null; pid: number | undefined };

export function killGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL') {
  if (!pid) return;
  try {
    process.kill(-pid, signal); // negative pid = the whole process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function runProcess(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let reason: Exclude<RunOutcome, 'ok' | 'failed'> | null = null;
    const kill = (why: typeof reason) => {
      if (reason) return;
      reason = why;
      killGroup(child.pid);
    };
    const timers: NodeJS.Timeout[] = [];
    const interval = (fn: () => void, ms: number) => timers.push(setInterval(fn, ms));
    timers.push(setTimeout(() => kill('timeout'), Math.max(1, o.timeoutMs)));
    if (o.isCancelled) {
      let polling = false;
      interval(async () => {
        if (polling || reason) return;
        polling = true;
        try {
          if (await o.isCancelled!()) kill('cancelled');
        } catch {
          /* Redis hiccup: try again next tick */
        } finally {
          polling = false;
        }
      }, o.cancelPollMs ?? 1000);
    }
    if (o.watchFile) {
      const w = o.watchFile;
      interval(async () => {
        try {
          if (!reason && (await stat(w.path)).size > w.maxBytes) kill('too-large');
        } catch {
          /* file not created yet */
        }
      }, o.watchPollMs ?? 500);
    }
    const stop = () => timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
    const onData = (d: Buffer) => o.onOutput?.(d.toString());
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => {
      stop();
      reject(e);
    });
    child.on('close', (code) => {
      stop();
      // Whatever the exit status, make sure nothing from the group survives (a daemonised grandchild, say).
      killGroup(child.pid);
      resolve({ outcome: reason ?? (code === 0 ? 'ok' : 'failed'), code, pid: child.pid });
    });
  });
}
