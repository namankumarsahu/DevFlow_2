type Outcome = { projectId: string; detectedStack: string | null; status: string; preflight: unknown; failureClass: string | null; createdAt: Date; previewId?: string | null };
export function buildReliability(rows: Outcome[]) {
  const groups = new Map<string, { stack: string; success: number; failed: number; blocked: number; firstAttempts: number; firstSuccesses: number; failures: Record<string, number> }>();
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (row.previewId) continue;
    const first = !seen.has(row.projectId); seen.add(row.projectId);
    if (!row.detectedStack || !row.preflight || !['SUCCESS', 'FAILED'].includes(row.status)) continue;
    const group = groups.get(row.detectedStack) ?? { stack: row.detectedStack, success: 0, failed: 0, blocked: 0, firstAttempts: 0, firstSuccesses: 0, failures: {} };
    if (row.failureClass === 'preflight') group.blocked++;
    else {
      if (row.status === 'SUCCESS') group.success++; else group.failed++;
      if (first) { group.firstAttempts++; if (row.status === 'SUCCESS') group.firstSuccesses++; }
    }
    if (row.failureClass) group.failures[row.failureClass] = (group.failures[row.failureClass] ?? 0) + 1;
    groups.set(group.stack, group);
  }
  return [...groups.values()].map((g) => ({ ...g, firstAttemptSuccessRate: g.firstAttempts ? g.firstSuccesses / g.firstAttempts : null }));
}
