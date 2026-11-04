import { lstat, readFile } from 'fs/promises';
import path from 'path';

// Cheap static checks on the repository's Dockerfile BEFORE it reaches BuildKit. This is defence in depth, not the
// security boundary: the boundary is the rootless BuildKit sandbox, which also refuses insecure entitlements by default.
// The point is to reject obviously hostile or unsupported input early with a clear message.
export type LintOptions = { maxBytes: number };

// `# syntax=` makes BuildKit pull and RUN an arbitrary "frontend" image. Only Docker's own frontend is accepted.
const OFFICIAL_FRONTEND = /^(?:docker\.io\/)?docker\/dockerfile(?::[\w.-]+)?$/;

export function lintDockerfile(text: string, o: LintOptions): string[] {
  const problems: string[] = [];
  if (Buffer.byteLength(text) > o.maxBytes) problems.push(`Dockerfile is larger than ${Math.round(o.maxBytes / 1024)} KB`);
  if (text.includes('\0')) problems.push('Dockerfile contains binary data');
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    const syntax = /^\s*#\s*syntax\s*=\s*(\S+)/i.exec(line);
    if (syntax && !OFFICIAL_FRONTEND.test(syntax[1])) {
      problems.push(`line ${n}: custom Dockerfile frontend "${syntax[1]}" is not allowed (only docker/dockerfile)`);
    }
    if (/^\s*(?:RUN|COPY|ADD)\b.*--security\s*=\s*insecure/i.test(line)) problems.push(`line ${n}: --security=insecure is not allowed`);
    if (/^\s*RUN\b.*--network\s*=\s*host/i.test(line)) problems.push(`line ${n}: --network=host is not allowed`);
  }
  return problems;
}

// Reads <contextDir>/Dockerfile and lints it. Refuses symlinks (they could point at files on the worker).
export async function lintDockerfileAt(contextDir: string, o: LintOptions): Promise<string[]> {
  const file = path.join(contextDir, 'Dockerfile');
  let st;
  try {
    st = await lstat(file);
  } catch {
    return ['No Dockerfile found at the repository root'];
  }
  if (!st.isFile()) return ['Dockerfile must be a regular file (symlinks are not allowed)'];
  if (st.size > o.maxBytes) return [`Dockerfile is larger than ${Math.round(o.maxBytes / 1024)} KB`];
  return lintDockerfile(await readFile(file, 'utf8'), o);
}
