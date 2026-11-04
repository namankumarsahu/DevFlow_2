// Step 6: build sandbox helpers. Pure functions only.

// The rootless BuildKit daemon runs in its own container, so the builds no longer run on the host's
// Docker daemon. The worker only talks to it over the private `devflow_builds` network.
export type BuildctlOpts = { addr: string; contextDir: string; dockerfileDir?: string; imageTag: string; tarPath: string };

export function buildctlArgs(o: BuildctlOpts): string[] {
  return [
    '--addr', o.addr,
    'build',
    // Public CA certificates only. Dockerfiles can opt in with a BuildKit secret
    // mount when the host uses an enterprise proxy or antivirus TLS inspection.
    '--secret', 'id=devflow_ca,src=/etc/ssl/certs/ca-certificates.crt',
    '--frontend', 'dockerfile.v0',
    '--local', `context=${o.contextDir}`,
    '--local', `dockerfile=${o.dockerfileDir ?? o.contextDir}`,
    // Exported as a tarball and loaded into the app daemon afterwards, so no registry is needed yet.
    '--output', `type=docker,name=${o.imageTag},dest=${o.tarPath}`,
    '--progress', 'plain',
  ];
}

export const buildctlPingArgs = (addr: string) => ['--addr', addr, 'debug', 'workers'];

// Environment for child processes (git, docker, buildctl). The worker's own env holds DATABASE_URL,
// JWT_SECRET and ENCRYPTION_KEY; none of the tools we spawn need them, so they get a short allow-list.
const ALLOWED_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'DOCKER_HOST', 'DOCKER_CONFIG', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

export function childEnv(parent: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ALLOWED_ENV) {
    const v = parent[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...extra };
}

// `git clone` of an untrusted repo: never prompt for credentials, never use local-path / ext transports,
// never fetch submodules, and keep the checkout shallow.
export function gitCloneArgs(branch: string, repoUrl: string, dest: string): string[] {
  return [
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    'clone', '--depth', '1', '--no-tags', '--no-recurse-submodules',
    '--branch', branch, '--', repoUrl, dest,
  ];
}
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };

export function checkRepoSize(bytes: number, maxMb: number): string | null {
  const mb = bytes / (1024 * 1024);
  return mb > maxMb ? `Repository is ${Math.round(mb)} MB, above the ${maxMb} MB limit for builds` : null;
}
