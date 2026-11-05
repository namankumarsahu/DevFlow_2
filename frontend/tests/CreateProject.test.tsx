import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import CreateProject from '../src/components/CreateProject';
import { api, type Project } from '../src/api';
import type { PreflightResult } from '../src/components/Requirements';
import { initialSetup, SKIP_MIGRATIONS } from '../src/lib/projectSetup';

vi.mock('../src/api', async importOriginal => ({ ...await importOriginal<typeof import('../src/api')>(), api: vi.fn() }));
const request = vi.mocked(api);
let project: Project;
let result: () => PreflightResult;
let put: (key: string) => Promise<void>;
let deploy: () => Promise<unknown>;
const onProject = vi.fn(), onDeployed = vi.fn();
function ready(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return { version: 7, status: 'supported', reason: 'Supported', stack: 'Express', requiredEnv: [], findings: [],
    plan: { id: 'a'.repeat(64), version: 1, revision: 'b'.repeat(40), root: '.', scope: 'web-service', port: 3000, healthPath: '/', evidence: ['package.json'],
      limits: { memoryMb: 256, cpus: .25, diskMb: 512 }, releaseCommand: project?.releaseCommand ?? null, seedCommand: null,
      components: [{ root: '.', framework: 'Express', runtime: 'node:22-alpine', install: 'npm ci', build: 'npm run build', start: 'npm run start:prod', port: 3000, output: null }], verification: 'HTTP checks only' }, ...overrides };
}
function blocked(names = ['DATABASE_URL']): PreflightResult {
  return ready({ status: 'unsupported', requiredEnv: names, findings: names.map(name => ({ id: `env.missing.${name}`, severity: 'blocker', message: `${name} is missing`, fix: `Add ${name}`, evidence: [] })) });
}
beforeEach(() => {
  project = { ...initialSetup(), id: 'draft', repoUrl: 'https://github.com/owner/my-app', name: 'my-app', branch: 'trunk', hasGithubToken: false } as Project;
  result = () => ready(); put = async () => {}; deploy = async () => ({ id: 'deployment', status: 'QUEUED' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ default_branch: 'trunk' }) })));
  request.mockImplementation(async (path, options) => {
    if (path === '/projects' && options?.method === 'POST') { project = { ...project, ...options.body as object }; return project as never; }
    if (path === '/projects/draft' && options?.method === 'PATCH') { project = { ...project, ...options.body as object }; return project as never; }
    if (path === '/projects/draft/preflight') return result() as never;
    if (path === '/projects/draft/env' && options?.method === 'PUT') { await put((options.body as { key: string }).key); return {} as never; }
    if (path === '/projects/draft/deploy') return await deploy() as never;
    throw new Error(`Unexpected API request: ${path}`);
  });
});
function setup() { return render(<MemoryRouter><CreateProject onProject={onProject} onDeployed={onDeployed} /></MemoryRouter>); }
async function analyze(url = 'https://github.com/owner/my-app.git/') {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Repository URL' }), url);
  await user.click(screen.getByRole('button', { name: 'Analyze' }));
  return user;
}
const deployButton = () => screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement;
const creates = () => request.mock.calls.filter(([path, opts]) => path === '/projects' && opts?.method === 'POST');

it('starts with one URL field and collapsed advanced settings, and reads the GitHub default branch', async () => {
  const { container } = setup();
  expect(within(screen.getByRole('form', { name: 'Analyze repository' })).getAllByRole('textbox')).toHaveLength(1);
  expect(container.querySelector('details')?.open).toBe(false);
  expect(screen.queryByRole('spinbutton', { name: 'Container port' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Environment' })).toBeNull();
  await analyze();
  await screen.findByRole('region', { name: 'Deployment review' });
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(creates()[0][1]?.body).toMatchObject({ name: 'my-app', repoUrl: 'https://github.com/owner/my-app', branch: 'trunk', containerPort: 3000, environment: 'PRODUCTION' });
  expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/owner/my-app', expect.objectContaining({ credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } }));
  expect(screen.getByText('npm run start:prod')).toBeTruthy();
  expect(request.mock.calls.some(([path]) => path.endsWith('/deploy'))).toBe(false);
  expect(screen.queryByRole('radio')).toBeNull();
});

it('deploys the reviewed plan only after the user clicks Deploy', async () => {
  setup(); const user = await analyze();
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  await user.click(deployButton());
  await waitFor(() => expect(onDeployed).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft' })));
  expect(request).toHaveBeenCalledWith('/projects/draft/deploy', { method: 'POST', body: { planId: 'a'.repeat(64), overridePreflight: false } });
});

it('keeps Deploy disabled for blockers; saving secret inputs rechecks and deploys the new plan', async () => {
  let saved = false;
  result = () => saved ? { ...ready(), plan: { ...ready().plan!, id: 'c'.repeat(64) } } : blocked();
  put = async () => { saved = true; };
  const { container } = setup(); const user = await analyze();
  await screen.findByLabelText('DATABASE_URL'); expect(deployButton().disabled).toBe(true);
  expect(screen.queryByLabelText(/Override blockers/)).toBeNull();
  await user.type(screen.getByLabelText('DATABASE_URL'), 'fixture-secret');
  expect(container.textContent).not.toContain('fixture-secret');
  await user.click(screen.getByRole('button', { name: 'Save variables and analyze' }));
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(request).toHaveBeenCalledWith('/projects/draft/env', { method: 'PUT', body: { key: 'DATABASE_URL', value: 'fixture-secret' } });
  expect((screen.getByLabelText('DATABASE_URL') as HTMLInputElement).value).toBe('');
  expect(creates()).toHaveLength(1);
  await user.click(deployButton());
  await waitFor(() => expect(request).toHaveBeenCalledWith('/projects/draft/deploy', expect.objectContaining({ body: { planId: 'c'.repeat(64), overridePreflight: false } })));
});

it('allows warnings but requires saving any optional variable the user starts entering', async () => {
  result = () => ready({ status: 'supported-with-warnings', requiredEnv: ['OPTIONAL_KEY'], findings: [{ id: 'env.missing.OPTIONAL_KEY', severity: 'warning', message: 'Optional key', fix: 'Review the optional value', evidence: [] }] });
  setup(); const user = await analyze();
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  await user.type(screen.getByLabelText('OPTIONAL_KEY'), 'unsaved'); expect(deployButton().disabled).toBe(true);
});

it('reuses its draft and invalidates review when advanced settings change', async () => {
  setup(); const user = await analyze();
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  await user.click(screen.getByText('Advanced settings'));
  await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Custom name');
  expect(deployButton().disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Analyze settings' }));
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(creates()).toHaveLength(1);
  expect(request).toHaveBeenCalledWith('/projects/draft', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ name: 'Custom name' }) }));
});

it('does not guess main when GitHub metadata fails, and permits an explicit advanced branch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
  setup(); const user = await analyze();
  await screen.findByRole('alert'); expect(creates()).toHaveLength(0);
  expect((screen.getByRole('textbox', { name: 'Branch' }) as HTMLInputElement).value).toBe('');
  await user.type(screen.getByRole('textbox', { name: 'Branch' }), 'release/v2');
  await user.click(screen.getByRole('button', { name: 'Analyze settings' }));
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(creates()[0][1]?.body).toMatchObject({ branch: 'release/v2' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('offers both/frontend/backend choices and rechecks the selected app before enabling Deploy', async () => {
  const fullstack = (): PreflightResult => ({ ...ready(), stack: 'Frontend + FastAPI', plan: { ...ready().plan!, scope: 'cohosted-frontend-api',
    components: [{ ...ready().plan!.components[0], root: 'frontend', framework: 'vite' }, { ...ready().plan!.components[0], root: 'backend', framework: 'fastapi' }] } });
  result = () => project.rootDir ? { ...ready(), plan: { ...ready().plan!, root: project.rootDir, scope: project.rootDir === 'frontend' ? 'static-assets' : 'web-service' } } : fullstack();
  setup(); const user = await analyze(); await screen.findByRole('radio', { name: 'Both' });
  expect((screen.getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole('radio', { name: 'Frontend only' }));
  await screen.findByText(/Static frontend only/); await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(project).toMatchObject({ rootDir: 'frontend', preset: null, useRepositoryConfig: false });
  await user.click(screen.getByRole('radio', { name: 'Backend only' }));
  await waitFor(() => expect(project.rootDir).toBe('backend'));
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  await user.click(screen.getByRole('radio', { name: 'Both' }));
  await waitFor(() => expect(project).toMatchObject({ rootDir: null, useRepositoryConfig: true }));
  expect(creates()).toHaveLength(1);
});

it('uses detected folder and Python dropdowns for ambiguous candidates', async () => {
  const choices = [
    { label: 'frontend', rootDir: 'apps/web', preset: null, entrypoint: null, scope: 'Frontend' },
    { label: 'api one', rootDir: 'services/api', preset: 'PYTHON_FASTAPI' as const, entrypoint: 'main:app', scope: 'API' },
    { label: 'api two', rootDir: 'services/api', preset: 'PYTHON_FASTAPI' as const, entrypoint: 'other:app', scope: 'API' },
  ];
  result = () => project.entrypoint ? ready() : { version: 7, stack: null, status: 'unsupported', reason: 'Ambiguous', requiredEnv: [], choices,
    findings: [{ id: 'layout.unrecognized', severity: 'blocker', message: 'Choose an app', fix: 'Choose a candidate', evidence: [] }] };
  setup(); const user = await analyze();
  const folder = await screen.findByRole('combobox', { name: 'App folder' });
  expect(deployButton().disabled).toBe(true);
  await user.selectOptions(folder, 'services/api');
  const target = await screen.findByRole('combobox', { name: 'Python entry point' });
  await waitFor(() => expect((target as HTMLSelectElement).disabled).toBe(false));
  await user.selectOptions(target, 'other:app');
  await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(project).toMatchObject({ rootDir: 'services/api', entrypoint: 'other:app', preset: 'PYTHON_FASTAPI', useRepositoryConfig: false });
  await user.click(screen.getByText('Advanced settings'));
  expect(screen.getByRole('combobox', { name: 'Root directory (optional)' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Python entry point (optional)' })).toBeTruthy();
});

it('automatically selects a single detected app, preserving the derived name and branch', async () => {
  result = () => project.rootDir ? ready() : { version: 7, stack: null, status: 'unsupported', reason: 'Choose', requiredEnv: [],
    findings: [{ id: 'layout.unrecognized', severity: 'blocker', message: 'Select root', fix: 'Use the detected root', evidence: [] }],
    choices: [{ rootDir: 'server', label: 'Server', preset: null, entrypoint: null, scope: 'API' }] };
  setup(); await analyze(); await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(project).toMatchObject({ rootDir: 'server', name: 'my-app', branch: 'trunk' });
  expect(screen.queryByRole('combobox', { name: 'App folder' })).toBeNull();
});

it('prefills migrations and skips an inherited command without disabling other repository defaults', async () => {
  result = () => ({ ...ready(), plan: { ...ready().plan!, releaseCommand: project.releaseCommand ?? 'npx prisma migrate deploy', seedCommand: 'node seed.js' } });
  setup(); const user = await analyze();
  const migrations = await screen.findByRole('checkbox', { name: 'Run database migrations on deploy' });
  await waitFor(() => expect((migrations as HTMLInputElement).disabled).toBe(false));
  expect((migrations as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole('textbox', { name: 'Seed command (optional, idempotent)' })).toBeNull();
  await user.click(migrations); await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(project).toMatchObject({ releaseCommand: SKIP_MIGRATIONS, useRepositoryConfig: true });
  expect((migrations as HTMLInputElement).checked).toBe(false);
  await user.click(migrations); await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(project.releaseCommand).toBe('npx prisma migrate deploy');
});

it('requires a new review after a stale-plan rejection and never retries Deploy automatically', async () => {
  deploy = async () => { throw new Error('Requirements changed or expired; run preflight again.'); };
  setup(); const user = await analyze(); await waitFor(() => expect(deployButton().disabled).toBe(false));
  await user.click(deployButton()); await screen.findByRole('alert');
  expect(deployButton().disabled).toBe(true); expect(onDeployed).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/deploy'))).toHaveLength(1);
});

it('expires a review after five minutes without queueing a deployment', async () => {
  vi.useFakeTimers(); setup();
  fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), { target: { value: 'https://github.com/owner/my-app' } });
  await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Analyze repository' })); });
  expect(deployButton().disabled).toBe(false);
  act(() => { vi.advanceTimersByTime(5 * 60_000 + 1); });
  expect(deployButton().disabled).toBe(true);
  expect(request.mock.calls.some(([path]) => path.endsWith('/deploy'))).toBe(false);
});

it('prevents duplicate draft creation on repeated submissions while metadata is pending', async () => {
  let complete!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { complete = resolve; })));
  setup();
  fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), { target: { value: 'https://github.com/owner/my-app' } });
  const form = screen.getByRole('form', { name: 'Analyze repository' }); fireEvent.submit(form); fireEvent.submit(form);
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => complete({ ok: true, json: async () => ({ default_branch: 'trunk' }) }));
  await waitFor(() => expect(creates()).toHaveLength(1));
});

it('surfaces creation quota failures without preflight or deployment calls', async () => {
  request.mockRejectedValue(new Error('Demo limit reached: at most 5 projects per account.'));
  setup(); await analyze();
  expect((await screen.findByRole('alert')).textContent).toContain('Demo limit reached');
  expect(request.mock.calls.some(([path]) => path.endsWith('/preflight') || path.endsWith('/deploy'))).toBe(false);
});

it('does not create a project after the user leaves while branch lookup is pending', async () => {
  let complete!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { complete = resolve; })));
  const view = setup();
  fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), { target: { value: 'https://github.com/owner/my-app' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Analyze repository' }));
  view.unmount();
  await act(async () => { complete({ ok: true, json: async () => ({ default_branch: 'trunk' }) }); });
  expect(creates()).toHaveLength(0);
});

it('preserves unsaved variables after a partial save failure and only retries those values', async () => {
  const saved = new Set<string>(); let failed = false;
  result = () => saved.size === 2 ? ready() : blocked(['DATABASE_URL', 'API_KEY']);
  put = async key => { if (key === 'API_KEY' && !failed) { failed = true; throw new Error('Could not save API_KEY'); } saved.add(key); };
  setup(); const user = await analyze();
  await user.type(await screen.findByLabelText('DATABASE_URL'), 'db-fixture'); await user.type(screen.getByLabelText('API_KEY'), 'api-fixture');
  await user.click(screen.getByRole('button', { name: 'Save variables and analyze' })); await screen.findByRole('alert');
  expect((screen.getByLabelText('DATABASE_URL') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('API_KEY') as HTMLInputElement).value).toBe('api-fixture'); expect(deployButton().disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Save variables and analyze' })); await waitFor(() => expect(deployButton().disabled).toBe(false));
  expect(request.mock.calls.filter(([path, opts]) => path.endsWith('/env') && (opts?.body as { key: string }).key === 'DATABASE_URL')).toHaveLength(1);
});
