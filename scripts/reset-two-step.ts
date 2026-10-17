#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { config as dotenvConfig } from "dotenv";

/**
 * The last-admin recovery path for two-step sign-in (spec §5.6): delete an
 * account's factor, backup codes, pending sign-in attempts and sessions, by
 * address, from a shell on the box.
 *
 * It is also the answer to a changed `SESSION_SECRET`: every stored TOTP
 * secret becomes unreadable exactly as connector credentials do, and this is
 * the documented way out for the person who can no longer get in.
 *
 * Runs the way `npm run db:prepare` does — `tsx`, with `.env` loaded before
 * anything reads the environment (the imports that bind the database are
 * dynamic on purpose: a static import would read `DATABASE_PATH` before
 * `dotenvConfig()` ran).
 */

export type ResetTwoStepResult = { userId: string; email: string };

/**
 * Clears that account's two-step state and sessions, or says there is no such
 * account. Exported so the unit test can run the same code the CLI runs
 * without spawning a process.
 */
export async function resetTwoStepByEmail(
	email: string,
): Promise<ResetTwoStepResult | null> {
	const { eq } = await import("drizzle-orm");
	const { db } = await import("../src/lib/server/db");
	const { users } = await import("../src/lib/server/db/schema");
	const { resetTwoStepForUser } = await import(
		"../src/lib/server/services/two-step"
	);

	const normalized = email.trim().toLowerCase();
	const [user] = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(eq(users.email, normalized))
		.limit(1);
	if (!user) return null;

	await resetTwoStepForUser(user.id);
	return { userId: user.id, email: user.email };
}

function readEmailArgument(argv: string[]): string | null {
	const inline = argv.find((argument) => argument.startsWith("--email="));
	if (inline) return inline.slice("--email=".length) || null;
	const index = argv.indexOf("--email");
	if (index === -1) return null;
	return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
	dotenvConfig();
	if (!process.env.DATABASE_PATH) {
		process.env.DATABASE_PATH = "./data/chat.db";
	}

	const email = readEmailArgument(process.argv.slice(2));
	if (!email) {
		console.error("Usage: npm run auth:reset-two-step -- --email <address>");
		process.exitCode = 1;
		return;
	}

	const result = await resetTwoStepByEmail(email);
	if (!result) {
		console.error(`No account with the address ${email}.`);
		process.exitCode = 1;
		return;
	}

	console.log(
		`Two-step sign-in reset for ${result.email}: factor, backup codes, pending sign-in attempts and every session deleted.`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	void main();
}
