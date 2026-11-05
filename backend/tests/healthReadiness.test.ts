import { waitHealthy } from '../src/lib/health';

it('retains the legacy availability check for API roots that return 404', async () => {
  expect(await waitHealthy({ probe: async () => 404, isAlive: async () => true, timeoutMs: 20, successesNeeded: 1 })).toMatchObject({ ok: true });
});
it.each([302, 401, 404, 500])('rejects HTTP %i on an explicit readiness endpoint', async status => {
  expect(await waitHealthy({ probe: async () => status, isAlive: async () => true, timeoutMs: 1, intervalMs: 1, successesNeeded: 1, acceptStatus: code => code >= 200 && code < 300 })).toMatchObject({ ok: false, reason: 'timeout', lastStatus: status });
});
it('requires consecutive successful readiness responses and resets on a missing endpoint', async () => {
  const responses = [200, 404, 200, 200];
  expect(await waitHealthy({ probe: async () => responses.shift() ?? 500, isAlive: async () => true, timeoutMs: 1000, intervalMs: 1, successesNeeded: 2, acceptStatus: code => code >= 200 && code < 300 })).toMatchObject({ ok: true, attempts: 4 });
});
