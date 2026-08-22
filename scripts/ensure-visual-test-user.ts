#!/usr/bin/env tsx
// Dev-only helper: ensure the visual-test@local user (the fixed id the mock
// seed writes its conversation under) exists with a known password so the
// seeded surfaces can be opened in a browser. Not part of any product flow.
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

if (!process.env.SESSION_SECRET)
	process.env.SESSION_SECRET =
		"test-session-secret-12345678901234567890123456789012";
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/index";
import { users } from "$lib/server/db/schema";

const USER_ID = "79c416c7-2053-4229-8f44-4368ffb77d61";
const EMAIL = "visual-test@local";
const PASSWORD = "test1234";

async function main() {
	const passwordHash = bcrypt.hashSync(PASSWORD, 10);
	const existing = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, USER_ID));
	if (existing.length > 0) {
		await db
			.update(users)
			.set({ passwordHash, email: EMAIL })
			.where(eq(users.id, USER_ID));
		console.log(`Updated ${EMAIL} password.`);
	} else {
		await db.insert(users).values({
			id: USER_ID,
			email: EMAIL,
			name: "Visual Test",
			passwordHash,
			role: "user",
		});
		console.log(`Created ${EMAIL}.`);
	}
	console.log(`Login: ${EMAIL} / ${PASSWORD}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
