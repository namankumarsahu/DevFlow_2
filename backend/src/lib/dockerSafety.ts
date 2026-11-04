import { KEPT_CAPS } from './limits';

// Allow-list validator for the `docker run` argument vector the worker builds for a USER app.
// Nothing user-controlled is supposed to reach these arguments; this exists so that a future change (or a bug) that
// would add a privileged flag, a host mount, host networking, the Docker socket, etc. fails loudly instead of silently.
export type RunContext = { network: string; envFile: string };

const num = /^\d+$/;
const rules: Record<string, (v: string, c: RunContext) => boolean> = {
  '--name': (v) => /^devflow-[\w-]+$/.test(v),
  '--restart': (v) => v === 'unless-stopped',
  '--network': (v, c) => v === c.network && v !== 'host' && !v.startsWith('container:'),
  '--env-file': (v, c) => v === c.envFile,
  '--memory': (v) => /^\d+m$/.test(v),
  '--memory-swap': (v) => /^\d+m$/.test(v),
  '--cpus': (v) => /^\d+(\.\d{1,3})?$/.test(v),
  '--pids-limit': (v) => num.test(v),
  '--ulimit': (v) => /^nofile=\d+:\d+$/.test(v),
  '--security-opt': (v) => v === 'no-new-privileges',
  '--cap-drop': (v) => v === 'ALL',
  '--cap-add': (v) => (KEPT_CAPS as readonly string[]).includes(v),
  '--tmpfs': (v) => /^\/tmp:rw,nosuid,size=\d+m$/.test(v),
  '--log-driver': (v) => v === 'json-file',
  '--log-opt': (v) => /^max-(size|file)=\w+$/.test(v),
  '--storage-opt': (v) => /^size=\d+m$/.test(v),
  '--label': (v) => /^devflow\.[a-z]+=[\w-]+$/.test(v),
};
const BOOLEAN_FLAGS = new Set(['-d']);
const IMAGE = /^devflow\/[\w-]+:[\w.-]+$/; // only images this platform built itself

export function assertSafeRunArgs(args: string[], ctx: RunContext): void {
  const fail = (why: string): never => {
    throw new Error(`Unsafe docker run argument rejected: ${why}`);
  };
  if (args[0] !== 'run') fail('not a "docker run" command');
  if (args.some((a) => a.includes('docker.sock'))) fail('the Docker socket must never be exposed to an app');
  let i = 1;
  for (; i < args.length - 1; i++) {
    const flag = args[i];
    if (BOOLEAN_FLAGS.has(flag)) continue;
    const rule = rules[flag];
    if (!rule) return fail(`flag ${flag}`); // includes --privileged, -v/--volume/--mount, --pid, --device, --userns, ...
    const value = args[++i];
    if (value === undefined || !rule(value, ctx)) return fail(`${flag} ${value ?? ''}`);
  }
  if (i !== args.length - 1 || !IMAGE.test(args[args.length - 1])) fail('the last argument must be a DevFlow-built image');
}
