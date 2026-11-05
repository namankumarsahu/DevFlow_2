// Single source of truth for the API, preflight classification and support docs.
export const SUPPORT_VERSION = 6;
export const supportMatrix = {
  stacks: [
    { id: 'static', name: 'Static sites', layouts: 'index.html at root or dist/build/public/out' },
    { id: 'node', name: 'Node: Express/Nest, Next.js, Vite/CRA', layouts: 'package.json; npm/yarn/pnpm; start or main; build script for frontends' },
    { id: 'python', name: 'Python: Django, Flask, FastAPI', layouts: 'requirements.txt or pip-installable pyproject.toml; WSGI or module-level app' },
    { id: 'fullstack', name: 'Frontend + backend', layouts: 'one frontend/client/web and one backend/server/api; static/Vite/CRA frontend' },
    { id: 'dockerfile', name: 'Repository Dockerfile', layouts: 'one self-contained HTTP image; existing sandbox/image policies apply' },
  ],
  conditional: ['External databases, object storage, email and paid APIs require owner-provided services and configuration.', 'Compatibility checks are heuristics, not proof of application correctness or credential validity.'],
  unsupported: ['docker-compose multi-service deployments', 'Unconfigured credentials or paid services (no automatic provisioning)', 'Local GPU/ML inference, including CPU-loaded LLMs (use external inference APIs)', 'Streamlit auto-build (provide a root Dockerfile)', 'Custom infrastructure', 'Native desktop/mobile applications', 'Long-running workers or cron without HTTP', 'Host mounts and persistent local app storage'],
} as const;
export type SupportStatus = 'supported' | 'supported-with-warnings' | 'unsupported';
