export type HttpErrorExtra = {
  code?: string; // stable machine-readable reason, e.g. ACTIVE_APP_QUOTA_REACHED
  data?: Record<string, unknown>; // extra JSON fields merged into the error body
  headers?: Record<string, string>; // e.g. Retry-After
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: HttpErrorExtra = {}) {
    super(message);
  }
}
