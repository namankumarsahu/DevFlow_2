// This sibling must not be inspected or included in a frontend-only build.
const database = process.env.DATABASE_URL;
throw new Error('Unselected sibling must never execute');
