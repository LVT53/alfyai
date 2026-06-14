import bcrypt from "bcryptjs";
import { db } from "../src/lib/server/db/index.js";
import { users } from "../src/lib/server/db/schema.js";

async function main() {
	const id = "test";
	const email = "test@example.com";
	const name = "Test User";
	const passwordHash = bcrypt.hashSync("password", 10);

	try {
		await db.insert(users).values({
			id,
			email,
			name,
			passwordHash,
		});
		console.log("Test user created");
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
			console.log("Test user already exists");
		} else {
			console.error(err);
		}
	}
}
main();
