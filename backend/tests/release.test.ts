import { assertSafeReleaseArgs, runReleaseCommands } from '../src/lib/release';
import { assertSafeRunArgs } from '../src/lib/dockerSafety';
import { runLimitArgs } from '../src/lib/limits';
import { DeployTimeout } from '../src/lib/deployCleanup';
const ctx = { network: 'apps', envFile: '/tmp/secret.env' };
const limits = runLimitArgs({ memoryMb: 256, cpus: 0.25, diskMb: 512 }, { pidsLimit: 256, nofile: 4096, tmpMb: 64, logMaxSize: '10m', logMaxFiles: 3, storageQuota: false });
const args = (command = 'npx prisma migrate deploy') => ['run','--name','devflow-release-id-0','--network','apps','--env-file',ctx.envFile,...limits,'--entrypoint','/bin/sh','devflow/project:commit','-ec',command];
it('keeps the existing app allow-list unchanged and narrowly validates releases', () => {
  expect(() => assertSafeRunArgs(args(), ctx)).toThrow();
  expect(() => assertSafeReleaseArgs(args(), ctx)).not.toThrow();
  for (const forbidden of [['--mount','type=bind,src=/,dst=/host'], ['--privileged'], ['--entrypoint','/bin/bash'], ['--network','host'], ['-d']]) expect(() => assertSafeReleaseArgs(['run',...forbidden,...args().slice(1)],ctx)).toThrow();
  expect(() => assertSafeReleaseArgs(args('echo ok\nRUN evil'),ctx)).toThrow();
  expect(() => assertSafeReleaseArgs(args('echo "quoted"; printf "\\n"'),ctx)).not.toThrow();
});
it('runs release then seed with the same image, environment and caps, cleaning both containers', async () => {
  const run = jest.fn(async(_args: string[])=>undefined), remove = jest.fn(async(_name: string)=>undefined);
  await runReleaseCommands(['migrate','seed'], { ...ctx, deploymentId:'id', image:'devflow/project:commit', limits, run, remove, log:async()=>undefined });
  expect(run.mock.calls.map((c:any)=>c[0].slice(-1)[0])).toEqual(['migrate','seed']);
  expect(run.mock.calls[0][0]).toEqual(expect.arrayContaining(['--memory','256m','--cpus','0.25','--env-file',ctx.envFile]));
  expect(remove.mock.calls).toEqual([['devflow-release-id-0'],['devflow-release-id-1']]);
});
it.each([new Error('migration failed'), new DeployTimeout('deployment budget expired')])('cleans up and propagates failure/timeout without running seed', async failure => {
  const run = jest.fn(async(_args: string[])=>{ throw failure; }), remove = jest.fn(async(_name: string)=>undefined);
  await expect(runReleaseCommands(['migrate','seed'], { ...ctx, deploymentId:'id', image:'devflow/project:commit', limits, run, remove, log:async()=>undefined })).rejects.toBe(failure);
  expect(run).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith('devflow-release-id-0');
});
