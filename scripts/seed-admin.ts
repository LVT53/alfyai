#!/usr/bin/env tsx
// Create a user with optional admin role.
// Usage: npx tsx scripts/seed-admin.ts --email=admin@example.com --password=secret [--name="Admin"] [--admin]

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'seed-placeholder-session-secret-12345678';
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = './data/chat.db';

import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

const dbDir = dirname(process.env.DATABASE_PATH!);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

import { db } from '$lib/server/db/index';
import { users } from '$lib/server/db/schema';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

async function main() {
  execSync('npm run db:prepare', { stdio: 'inherit' });

  const args = process.argv.slice(2);

  const get = (flag: string) => {
    const a = args.find(a => a.startsWith(`--${flag}=`));
    return a ? a.split('=').slice(1).join('=') : undefined;
  };
  const has = (flag: string) => args.includes(`--${flag}`);

  const email = get('email');
  const password = get('password');
  const name = get('name') ?? 'Admin';
  const makeAdmin = has('admin');

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/seed-admin.ts --email=<email> --password=<password> [--name=<name>] [--admin]');
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const role = makeAdmin ? 'admin' : 'user';

  // Check if user already exists
  const existing = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, email));

  if (existing.length > 0) {
    // Update existing user's role if --admin flag was passed
    if (makeAdmin) {
      await db.update(users).set({ role: 'admin', updatedAt: new Date() }).where(eq(users.email, email));
      console.log(`✓ Updated existing user ${email} to role: admin`);
    } else {
      console.log(`User ${email} already exists with role: ${existing[0].role}`);
    }
    process.exit(0);
  }

  const id = randomUUID();
  await db.insert(users).values({ id, email, name, passwordHash, role });
  console.log(`✓ Created ${role} user: ${email} (id: ${id})`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
