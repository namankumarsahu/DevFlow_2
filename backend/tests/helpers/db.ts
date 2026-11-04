import { FakeDb } from './fakeDb';
export const db = new FakeDb();
export const queue = { add: jest.fn(async () => undefined), getJob: jest.fn(async () => null) };
export const redisValues = new Map<string, string>();
export const redis = {
  get: jest.fn(async (k: string) => redisValues.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => (redisValues.set(k, v), 'OK')),
  del: jest.fn(async (k: string) => (redisValues.delete(k), 1)),
  publish: jest.fn(async () => 1),
};
