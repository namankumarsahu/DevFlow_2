import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import BuildFields, { defaultBuildSettings } from '../src/components/BuildFields';

it('preserves manual fallbacks when no folders or Python candidates were detected', () => {
  render(<BuildFields value={defaultBuildSettings} onChange={vi.fn()} />);
  expect(screen.getByRole('textbox', { name: 'Root directory (optional)' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Python entry point (optional)' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Help: App folder' }).getAttribute('href')).toContain('/docs/CREATE-PROJECT.md');
});
it('offers detected candidates rather than free-text folder and entry-point inputs', async () => {
  const onChange = vi.fn();
  render(<BuildFields value={defaultBuildSettings} onChange={onChange} rootChoices={['.', 'api']} entrypointChoices={['main:app', 'other:app']} />);
  expect(screen.queryByRole('textbox', { name: 'Root directory (optional)' })).toBeNull();
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Python entry point (optional)' }), 'other:app');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ entrypoint: 'other:app' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Root directory (optional)' }), 'api');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rootDir: 'api', entrypoint: null }));
});
it('retains Dockerfile command restrictions and all existing advanced controls', () => {
  render(<BuildFields value={{ ...defaultBuildSettings, buildMode: 'DOCKERFILE' }} onChange={vi.fn()} />);
  expect((screen.getByRole('textbox', { name: 'Start command (optional)' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'Build command (optional)' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'Python entry point (optional)' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'Release command (optional)' }) as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByRole('textbox', { name: 'Seed command (optional, idempotent)' })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /Use devflow.json defaults/ })).toBeTruthy();
});
