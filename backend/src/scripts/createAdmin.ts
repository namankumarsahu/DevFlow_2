import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';

// Creates (or promotes) the operator account. Used in demo mode, where public sign-up never yields an ADMIN.
//   docker compose exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='long passphrase' api node dist/scripts/createAdmin.js
// The password is read from the environment, not argv, so it stays out of the process list and shell history.
async function main() {
  const { email, password } = z
    .object({ email: z.string().email().toLowerCase(), password: z.string().min(12).max(128) })
    .parse({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role: 'ADMIN' },
    update: { passwordHash, role: 'ADMIN' },
  });
  console.log(`Admin account ready: ${user.email}`);
}

main()
  .catch((e) => {
    console.error('Could not create the admin:', e instanceof z.ZodError ? 'set ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars)' : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
