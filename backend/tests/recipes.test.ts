import { readdir } from 'fs/promises';
import path from 'path';
import { preflight } from '../src/lib/autobuild/preflight';
import { prepareBuild, analyzeDeployment } from '../src/lib/autobuild';
import { lintDockerfile } from '../src/lib/dockerfileLint';
const { inspectFixture } = require('../scripts/fixture-suite.cjs');
describe('real project recipe regressions', () => {
  let fixtureNames: string[];
  beforeAll(async () => { fixtureNames = (await readdir(path.join(__dirname, 'fixtures/real'))).filter(n => !n.endsWith('.md')); });
  it('matches every committed expected detection, finding and Dockerfile property', async () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(6);
    for (const name of fixtureNames) {
      const fixture = await inspectFixture(path.join(__dirname, 'fixtures/real', name), { preflight, prepareBuild, analyzeDeployment });
      try {
        expect({ fixture: name, stack: fixture.requirements.stack, status: fixture.requirements.status, findings: [...new Set(fixture.requirements.findings.map((f: any) => f.id))].sort() }).toEqual({ fixture: name, stack: fixture.expected.stack, status: fixture.expected.status, findings: [...fixture.expected.findings].sort() });
        if (fixture.dockerfile) {
          expect(lintDockerfile(fixture.dockerfile, { maxBytes: 102400 })).toEqual([]);
          for (const property of fixture.expected.properties) expect(fixture.dockerfile).toContain(property);
          expect(fixture.dockerfile).not.toMatch(/actual-secret-value|DO_NOT_LEAK/);
        } else expect(fixture.expected.status).toBe('unsupported');
      } finally { await fixture.cleanup(); }
    }
  });
});
