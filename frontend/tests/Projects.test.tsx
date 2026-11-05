import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import Projects from '../src/pages/Projects';
import { api, type Project } from '../src/api';
import { initialSetup } from '../src/lib/projectSetup';

vi.mock('../src/api', async importOriginal => ({ ...await importOriginal<typeof import('../src/api')>(), api: vi.fn() }));
vi.mock('../src/components/UsageBanner', () => ({ default: () => null, useUsage: () => undefined }));

it('keeps analyzed drafts when the initial project list arrives late and navigates only after Deploy', async () => {
  let finishList!: (projects: Project[]) => void;
  const project = { ...initialSetup(), id: 'draft', name: 'site', branch: 'master', repoUrl: 'https://github.com/owner/site' } as Project;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ default_branch: 'master' }) })));
  vi.mocked(api).mockImplementation(async (path, opts) => {
    if (path === '/projects' && !opts?.method) return await new Promise<Project[]>(resolve => { finishList = resolve; }) as never;
    if (path === '/projects' && opts?.method === 'POST') return project as never;
    if (path === '/projects/draft/preflight') return { version: 7, status: 'supported', stack: 'Static site', findings: [], requiredEnv: [], plan: { id: 'a'.repeat(64), root: '.', scope: 'static-assets', releaseCommand: null, components: [{ framework: 'static', root: '.', build: null, start: 'nginx' }] } } as never;
    if (path === '/projects/draft/deploy') return { id: 'deployment' } as never;
    throw new Error(`Unexpected API call: ${path}`);
  });
  render(<MemoryRouter><Routes><Route path="/" element={<Projects />} /><Route path="/projects/draft" element={<h1>Project details</h1>} /></Routes></MemoryRouter>);
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Repository URL' }), project.repoUrl);
  await user.click(screen.getByRole('button', { name: 'Analyze' }));
  await screen.findByRole('region', { name: 'Deployment review' });
  await act(async () => { finishList([{ ...project, id: 'existing', name: 'Existing app' }]); });
  expect(await screen.findByRole('link', { name: /Existing app PRODUCTION/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /site PRODUCTION/ })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Project details' })).toBeNull();
  const button = screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await user.click(button);
  expect(await screen.findByRole('heading', { name: 'Project details' })).toBeTruthy();
});
