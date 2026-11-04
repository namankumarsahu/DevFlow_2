import { assertSafeRunArgs, RunContext } from './dockerSafety';
import { validCommand } from './autobuild/render';

// Keep the app-run validator unchanged. This narrowly scoped adapter accepts
// one fixed shell entrypoint and one command argument AFTER the trusted image.
export function assertSafeReleaseArgs(args: string[], ctx: RunContext) {
  const entry = args.indexOf('--entrypoint');
  if (entry < 1 || args.filter((a) => a === '--entrypoint').length !== 1 || args[entry + 1] !== '/bin/sh' || args[args.length - 2] !== '-ec') throw new Error('Unsafe release entrypoint');
  const command = args[args.length - 1];
  if (!validCommand(command) || !command.trim()) throw new Error('Invalid release command');
  const prefix = args.slice(0, -2);
  prefix.splice(entry, 2);
  assertSafeRunArgs(prefix, ctx);
  if (prefix.includes('-d') || prefix.includes('--restart')) throw new Error('Release containers must run once in the foreground');
}
export async function runReleaseCommands(commands: (string | null | undefined)[], options: {
  deploymentId: string; image: string; network: string; envFile: string; limits: string[];
  run: (args: string[]) => Promise<void>; remove: (name: string) => Promise<void>; log: (line: string) => Promise<void>;
}) {
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    if (!command) continue;
    const name = `devflow-release-${options.deploymentId}-${index}`;
    const args = ['run', '--name', name, '--network', options.network, '--env-file', options.envFile, ...options.limits, '--label', `devflow.deployment=${options.deploymentId}`, '--entrypoint', '/bin/sh', options.image, '-ec', command];
    assertSafeReleaseArgs(args, options);
    await options.log(`==> Running ${index === 0 ? 'release' : 'seed'} command in a one-off container`);
    try { await options.run(args); }
    finally { try { await options.remove(name); } catch { await options.log(`==> Cleanup of release container ${name} needs a retry`); } }
  }
}
