// A small in-memory stand-in for the parts of Prisma the demo-mode code uses.
// It models ONE thing that matters for the quota: `SELECT ... FOR UPDATE` on a user row blocks every other
// transaction that tries to lock the same row until the holder's transaction ends (like Postgres row locks).
// Unknown `where` operators throw, so a typo in a query fails the test instead of silently matching everything.
type Row = Record<string, any>;

const isOp = (v: any) => v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

function matches(row: Row, where: Row = {}, db?: FakeDb, table?: string): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w, db, table));
    if (k === 'AND') return (cond as Row[]).every((w) => matches(row, w, db, table));
    if (k === 'NOT') return !matches(row, cond as Row, db, table);
    // relation filter: project: { ownerId }
    if (k === 'project' && table === 'deployment') return matches(db!.tables.project.find((p) => p.id === row.projectId) ?? {}, cond as Row, db, 'project');
    const v = row[k] ?? null; // Prisma stores an undefined field as NULL
    if (!isOp(cond)) return v === (cond ?? null);
    return Object.entries(cond as Row).every(([op, x]) => {
      switch (op) {
        case 'in': return (x as any[]).includes(v);
        case 'not': return x === null ? v !== null && v !== undefined : v !== x;
        case 'gte': return v >= x;
        case 'lt': return v < x;
        case 'lte': return v <= x;
        case 'gt': return v > x;
        default: throw new Error(`fakeDb: unsupported operator ${op}`);
      }
    });
  });
}

let seq = 0;
const newId = () => `id-${++seq}`;

export class FakeDb {
  tables: Record<string, Row[]> = { user: [], project: [], deployment: [], deploymentAttempt: [], envVar: [], deploymentLog: [], preview: [] };
  private locks = new Map<string, Promise<void>>();
  lockCalls = 0;
  failNextQueueAdd = false;
  // Artificial latency between a transaction's read and its write: makes a missing lock visible as a race.
  txDelayMs = 5;

  private model(name: string) {
    const rows = () => this.tables[name];
    const select = (r: Row, sel?: Row) => (sel ? Object.fromEntries(Object.keys(sel).filter((k) => sel[k]).map((k) => [k, r[k]])) : { ...r });
    return {
      upsert: async ({ where, create, update }: Row) => {
        const key = Object.values(where)[0] as Row; // compound unique, e.g. { projectId_key: { projectId, key } }
        const r = rows().find((x) => matches(x, key, this, name));
        if (r) return Object.assign(r, update);
        const row = { id: newId(), ...create };
        rows().push(row);
        return row;
      },
      findMany: async ({ where, select: sel, orderBy, take, include }: Row = {}) => {
        let out = rows().filter((r) => matches(r, where, this, name));
        if (orderBy) {
          const [[k, dir]] = Object.entries(orderBy) as [string, string][];
          out = [...out].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        return out.slice(0, take ?? out.length).map((r) => ({ ...select(r, sel), ...(include?.owner ? { owner: { role: this.tables.user.find((u) => u.id === r.ownerId)?.role } } : {}) }));
      },
      findFirst: async (args: Row = {}) => (await this.model(name).findMany({ ...args, take: 1 }))[0] ?? null,
      findUnique: async ({ where, select: sel }: Row) => {
        const r = rows().find((x) => matches(x, where, this, name));
        return r ? select(r, sel) : null;
      },
      count: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where, this, name)).length,
      create: async ({ data }: Row) => {
        const row = { id: newId(), createdAt: new Date(), ...data };
        if (name === 'deployment') Object.assign(row, { status: 'QUEUED', previewId: null, ...data });
        if (name === 'user') row.role = data.role ?? 'USER';
        rows().push(row);
        return { ...row };
      },
      update: async ({ where, data }: Row) => {
        const r = rows().find((x) => matches(x, where, this, name));
        if (!r) throw new Error(`fakeDb: ${name} not found`);
        Object.assign(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = rows().filter((r) => matches(r, where, this, name));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      delete: async ({ where }: Row) => {
        const i = rows().findIndex((x) => matches(x, where, this, name));
        if (i < 0) throw new Error(`fakeDb: ${name} not found`);
        const [gone] = rows().splice(i, 1);
        if (name === 'project') ['deployment', 'envVar'].forEach((t) => (this.tables[t] = this.tables[t].filter((d) => d.projectId !== gone.id)));
        return gone;
      },
      deleteMany: async ({ where }: Row) => {
        const keep = rows().filter((r) => !matches(r, where, this, name));
        const n = rows().length - keep.length;
        this.tables[name] = keep;
        return { count: n };
      },
      aggregate: async () => ({ _max: { hostPort: Math.max(0, ...this.tables.project.map((p) => p.hostPort ?? 0)) || null } }),
    };
  }

  user = this.model('user');
  project = this.model('project');
  deployment = this.model('deployment');
  deploymentAttempt = this.model('deploymentAttempt');
  envVar = this.model('envVar');
  deploymentLog = this.model('deploymentLog');
  preview = this.model('preview');

  // Set to true to simulate "no row lock": the control experiment that proves the concurrency tests can catch a race.
  ignoreLocks = false;
  $queryRaw = async () => {
    throw new Error('fakeDb: raw queries are only supported inside a transaction');
  };

  // Each transaction gets its own view object so the lock is tied to the right transaction, even when several run at once.
  $transaction = async (fn: (tx: any) => Promise<any>) => {
    const ctx = { releases: [] as (() => void)[] };
    const self = this;
    const tx: any = Object.create(self);
    tx.$queryRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join('?');
      if (!/FROM "User" WHERE "id" = \? FOR UPDATE/.test(sql)) throw new Error(`fakeDb: unexpected raw query ${sql}`);
      self.lockCalls++;
      const user = self.tables.user.find((u) => u.id === values[0]);
      if (!self.ignoreLocks) {
        while (self.locks.has(values[0])) await self.locks.get(values[0]);
        let release!: () => void;
        self.locks.set(values[0], new Promise<void>((r) => (release = r)));
        ctx.releases.push(() => {
          self.locks.delete(values[0]);
          release();
        });
      }
      return user ? [{ id: user.id, role: user.role }] : [];
    };
    // Reads inside a transaction pause briefly after the lock, so unlocked code interleaves.
    const wrap = (model: any) =>
      new Proxy(model, {
        get: (t, prop: string) => async (...a: any[]) => {
          if (self.txDelayMs && prop !== 'create') await new Promise((r) => setTimeout(r, self.txDelayMs));
          return t[prop](...a);
        },
      });
    for (const m of ['project', 'deployment', 'deploymentAttempt', 'user']) tx[m] = wrap((self as any)[m]);
    try {
      return await fn(tx);
    } finally {
      ctx.releases.forEach((r) => r());
    }
  };

  seedUser(id: string, role: 'USER' | 'ADMIN' = 'USER', email = `${id}@example.com`) {
    this.tables.user.push({ id, email, role, createdAt: new Date(), passwordHash: 'x' });
    return id;
  }
  seedProject(id: string, ownerId: string, extra: Row = {}) {
    const row = { id, ownerId, name: id, repoUrl: 'https://github.com/o/r', branch: 'main', environment: 'PRODUCTION', containerPort: 3000, memoryMb: 256, cpus: 0.25, diskMb: 512, hostPort: 20000 + this.tables.project.length, slug: id, webhookSecret: 's', currentDeploymentId: null, previewsEnabled: false, githubTokenEnc: null, createdAt: new Date(), ...extra };
    this.tables.project.push(row);
    return row;
  }
  seedDeployment(id: string, projectId: string, status: string, extra: Row = {}) {
    const row = { id, projectId, status, previewId: null, triggeredById: null, createdAt: new Date(), ...extra };
    this.tables.deployment.push(row);
    return row;
  }
  // A project that is up and running.
  seedRunning(id: string, ownerId: string) {
    const p = this.seedProject(id, ownerId);
    this.seedDeployment(`${id}-live`, id, 'SUCCESS');
    p.currentDeploymentId = `${id}-live`;
    return p;
  }
}
