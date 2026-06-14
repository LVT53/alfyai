#!/usr/bin/env tsx

// Load environment variables from .env file first
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

// Set required environment variables if not set (or empty)
if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET =
		"test-session-secret-12345678901234567890123456789012";
}
if (!process.env.DATABASE_PATH) {
	process.env.DATABASE_PATH = "./data/chat.db";
}

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
// Import node modules
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Ensure the database directory exists (must be done before importing db module)
const dbDir = dirname(process.env.DATABASE_PATH);
if (!existsSync(dbDir)) {
	console.log(`Creating database directory: ${dbDir}`);
	mkdirSync(dbDir, { recursive: true });
}

import bcrypt from "bcryptjs";
// Import our application modules (now safe - env vars are already set and directory exists)
import { db } from "$lib/server/db/index";
import { users } from "$lib/server/db/schema";

async function main() {
	const args = process.argv.slice(2);
	const emailArg = args.find((arg) => arg.startsWith("--email="));
	const passwordArg = args.find((arg) => arg.startsWith("--password="));
	const nameArg = args.find((arg) => arg.startsWith("--name="));

	const email = emailArg ? emailArg.split("=")[1] : "admin@local";
	const password = passwordArg ? passwordArg.split("=")[1] : "admin123";
	const name = nameArg ? nameArg.split("=")[1] : "Admin User";

	// Prepare the database schema before seeding.
	try {
		execSync("npm run db:prepare", { stdio: "inherit" });
	} catch (migrationError) {
		console.error("Error preparing database:", migrationError);
		process.exit(1);
	}

	const id = randomUUID();
	const passwordHash = bcrypt.hashSync(password, 10);

	try {
		await db.insert(users).values({
			id,
			email,
			name,
			passwordHash,
		});
		console.log(`User created: ${email} (id: ${id})`);
	} catch (err: unknown) {
		const code =
			typeof err === "object" && err !== null && "code" in err
				? err.code
				: undefined;
		const message = err instanceof Error ? err.message : undefined;
		if (
			code === "SQLITE_CONSTRAINT_UNIQUE" ||
			message?.includes("UNIQUE constraint failed")
		) {
			console.log("User already exists");
			process.exit(0);
		} else {
			console.error("Error creating user:", err);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error("Unexpected error:", err);
	process.exit(1);
});
