const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function inspectFixture(root, library) {
  const expected = JSON.parse(await fs.readFile(path.join(root, 'expected.json'), 'utf8'));
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'devflow-real-fixture-'));
  const repo = path.join(staging, 'repo');
  try {
    await fs.cp(root, repo, { recursive: true, filter: p => !['expected.json', 'PROVENANCE.md'].includes(path.basename(p)) });
    const settings = expected.settings || {};
    const requirements = await library.preflight(repo, settings, expected.envNames || []);
    const logs = [];
    let plan, dockerfile;
    if (!requirements.findings.some(f => f.severity === 'blocker')) {
      plan = await library.prepareBuild(repo, settings, { port: 3000, limits: { memoryMb: 256, cpus: 0.25, diskMb: 512 } }, 102400, async line => logs.push(line));
      dockerfile = await fs.readFile(path.join(plan.dockerfileDir, 'Dockerfile'), 'utf8');
    }
    return { expected, requirements, plan, dockerfile, repo, cleanup: () => fs.rm(staging, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}
module.exports = { inspectFixture };
