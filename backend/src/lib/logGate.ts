// What may be stored / streamed as a deployment log line: capped in count, bytes and line length, with secrets masked.
// A hostile build can print gigabytes; without a cap that would fill the database and the browser.
export type LogGateOptions = { maxLines: number; maxBytes: number; maxLineChars: number; secrets?: () => string[] };

const PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /(?<=https?:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g, // user:password@ in URLs
  /(?<=aws_secret_access_key["'\s:=]{1,4})[A-Za-z0-9/+=]{30,}/gi,
];

export function redact(line: string, secrets: string[] = []): string {
  let out = line;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join('***');
  for (const re of PATTERNS) out = out.replace(re, '***');
  return out;
}

export function createLogGate(o: LogGateOptions) {
  let lines = 0;
  let bytes = 0;
  let announced = false;
  // Returns the lines to store/publish for one chunk of output (possibly none, possibly one final "truncated" notice).
  return (text: string): string[] => {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      const trimmed = raw.trimEnd();
      if (!trimmed) continue;
      if (lines >= o.maxLines || bytes >= o.maxBytes) {
        if (!announced) {
          announced = true;
          out.push(`==> Log output limit reached (${o.maxLines} lines / ${Math.round(o.maxBytes / 1024)} KB). Further output is dropped.`);
        }
        continue;
      }
      let line = redact(trimmed, o.secrets?.() ?? []);
      if (line.length > o.maxLineChars) line = line.slice(0, o.maxLineChars) + ' …[line truncated]';
      lines++;
      bytes += Buffer.byteLength(line);
      out.push(line);
    }
    return out;
  };
}
