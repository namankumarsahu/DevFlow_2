import { expect, it, vi } from 'vitest';
import { api, auth, ApiError } from '../src/api';
import { defaultBranch, repositoryIdentity } from '../src/lib/projectSetup';

it('keeps authenticated API requests same-origin with the existing JSON contract', async () => {
  auth.set('fixture-token');
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'draft' }), { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await api('/projects', { method: 'POST', body: { name: 'site' } })).toEqual({ id: 'draft' });
  expect(fetcher).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token' }, body: '{"name":"site"}' }));
});
it('preserves backend validation details and machine-readable error codes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid project', code: 'INVALID_PROJECT', details: { branch: ['Invalid branch'] } }), { status: 400 })));
  await expect(api('/projects', { method: 'POST' })).rejects.toMatchObject({ status: 400, code: 'INVALID_PROJECT', message: 'Invalid project — Invalid branch' });
  try { await api('/projects'); } catch (error) { expect(error).toBeInstanceOf(ApiError); }
});
it('does not clear an existing token merely because a sign-in attempt returns 401', async () => {
  auth.set('fixture-token');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 })));
  await expect(api('/auth/login', { method: 'POST' })).rejects.toMatchObject({ status: 401 });
  expect(auth.get()).toBe('fixture-token');
});
it('never sends the DevFlow authentication token to GitHub metadata requests', async () => {
  auth.set('fixture-token');
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ default_branch: 'master' })));
  vi.stubGlobal('fetch', fetcher);
  expect(await defaultBranch(repositoryIdentity('https://github.com/owner/repo.git/'))).toBe('master');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/vnd.github+json' } });
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('fixture-token');
});
it.each(['http://github.com/o/r', 'https://github.com.evil.test/o/r', 'https://name:secret@github.com/o/r', 'https://github.com/o/r?token=secret', 'https://github.com/o/r/tree/main', 'not a URL'])('rejects unsupported repository URL shapes before creating a project: %s', raw => {
  expect(() => repositoryIdentity(raw)).toThrow();
});
it('rejects missing or invalid GitHub branch metadata instead of guessing main', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ default_branch: '--upload-pack=evil' }))));
  await expect(defaultBranch(repositoryIdentity('https://github.com/o/r'))).rejects.toThrow('enter the branch in Advanced settings');
});
