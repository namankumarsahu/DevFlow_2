// Opt-in Docker integration tests. Fixture code executes only in Docker.
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { inspectFixture } = require('./fixture-suite.cjs');
const library = { ...require('../dist/lib/autobuild'), ...require('../dist/lib/autobuild/preflight') };
const docker = (...args) => exec('docker', args, { timeout: 300000, maxBuffer: 12 * 1024 * 1024 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = path.join(__dirname, '../tests/fixtures/real');
  for (const name of (await fs.readdir(root)).sort()) {
    if (!(await fs.stat(path.join(root, name))).isDirectory()) continue;
    const fixture = await inspectFixture(path.join(root, name), library);
    let container;
    try {
      if (!fixture.plan) { console.log(`SKIP ${name}: preflight blockers (expected unsupported fixture)`); continue; }
      const image = `devflow-fixture-${name}:phase2`;
      const secret = process.env.DEVFLOW_CA_BUNDLE;
      await docker('build', ...(secret ? ['--secret', `id=devflow_ca,src=${secret}`] : []), '-f', path.join(fixture.plan.dockerfileDir, 'Dockerfile'), '-t', image, fixture.plan.contextDir || fixture.repo);
      const { stdout } = await docker('image', 'inspect', image);
      const metadata = JSON.parse(stdout)[0];
      if (!metadata.Config.User || ['0', 'root'].includes(metadata.Config.User) || metadata.Size >= 1024 * 1024 * 1024) throw new Error('Image must be non-root and below 1 GB');
      container = `devflow-fixture-${name}-${process.pid}`;
      const network = process.env.DEVFLOW_TEST_NETWORK;
      const env = ['-e', 'PORT=3587', '-e', 'DJANGO_SECRET_KEY=fixture-only-not-a-real-credential', '-e', 'DEVFLOW_TRUSTED_PROXIES=127.0.0.1,::1'];
      await docker('run', '-d', '--name', container, '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.25', '--pids-limit', '256', '--security-opt', 'no-new-privileges', ...(network ? ['--network', network] : ['-p', '127.0.0.1::3587']), ...env, image);
      const address = network ? `${container}:3587` : (await docker('port', container, '3587/tcp')).stdout.trim();
      let ready = false;
      for (let i = 0; i < 90; i++) {
        try { const response = await fetch(`http://${address}/`, { signal: AbortSignal.timeout(2000) }); await response.text(); if (response.status === 200) { ready = true; break; } } catch {}
        await delay(500);
      }
      if (!ready) throw new Error((await docker('logs', '--tail', '30', container)).stdout + ' GET / did not return 200');
      console.log(`PASS ${name}: Docker build, non-root, <1GB, GET / 200 with PORT=3587 at 256MB/0.25CPU`);
    } finally { if (container) await docker('rm', '-f', container).catch(() => {}); await fixture.cleanup(); }
  }
})().catch(error => { console.error(error.stderr || error.message); process.exitCode = 1; });
