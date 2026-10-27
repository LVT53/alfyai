import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { artifacts, imageDescriptions, users } from "$lib/server/db/schema";
import {
	getImageDescriptions,
	saveImageDescription,
} from "./descriptions-store";

// The shared test database (src/vitest-setup.ts), migrated from ./drizzle, with
// foreign keys on. Every test makes its own people and files, and takes them
// away again through the users cascade.
const seededUsers: string[] = [];

async function seedUser(): Promise<string> {
	const id = `user-${randomUUID()}`;
	await db.insert(users).values({
		id,
		email: `${id}@example.com`,
		passwordHash: "hash",
	});
	seededUsers.push(id);
	return id;
}

async function seedPicture(userId: string, name = "kitchen.jpg") {
	const id = `artifact-${randomUUID()}`;
	await db.insert(artifacts).values({
		id,
		userId,
		type: "source_document",
		name,
		mimeType: "image/jpeg",
	});
	return id;
}

afterEach(async () => {
	for (const id of seededUsers.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("image descriptions store", () => {
	it("saves a description and reads it back by artifact id", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId);
		const garden = await seedPicture(userId, "garden.png");
		await saveImageDescription({
			userId,
			artifactId: kitchen,
			description: "A small white kitchen with a window.",
			modelName: "qwen3-8-flash-next",
		});

		const found = await getImageDescriptions(userId, [kitchen, garden]);

		expect([...found.entries()]).toEqual([
			[kitchen, "A small white kitchen with a window."],
		]);
	});

	it("keeps the first description when the same artifact is saved again", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId);
		await saveImageDescription({
			userId,
			artifactId: kitchen,
			description: "First description.",
			modelName: "first-model",
		});

		await expect(
			saveImageDescription({
				userId,
				artifactId: kitchen,
				description: "Second description.",
				modelName: "second-model",
			}),
		).resolves.toBeUndefined();

		const rows = await db
			.select()
			.from(imageDescriptions)
			.where(eq(imageDescriptions.artifactId, kitchen));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			description: "First description.",
			modelName: "first-model",
			userId,
		});
		expect(rows[0].createdAt).toBeInstanceOf(Date);
	});

	it("answers for the person who asks and nobody else", async () => {
		const owner = await seedUser();
		const stranger = await seedUser();
		const kitchen = await seedPicture(owner);
		await saveImageDescription({
			userId: owner,
			artifactId: kitchen,
			description: "A small white kitchen with a window.",
			modelName: "qwen3-8-flash-next",
		});

		expect((await getImageDescriptions(stranger, [kitchen])).size).toBe(0);
		expect((await getImageDescriptions(owner, [kitchen])).size).toBe(1);
	});

	it("reads nothing, and asks the database nothing, for an empty list", async () => {
		const userId = await seedUser();

		const found = await getImageDescriptions(userId, []);

		expect(found).toBeInstanceOf(Map);
		expect(found.size).toBe(0);
	});

	it("is removed with its artifact (foreign keys are on)", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId);
		await saveImageDescription({
			userId,
			artifactId: kitchen,
			description: "A small white kitchen with a window.",
			modelName: "qwen3-8-flash-next",
		});
		expect((await getImageDescriptions(userId, [kitchen])).size).toBe(1);

		await db.delete(artifacts).where(eq(artifacts.id, kitchen));

		expect((await getImageDescriptions(userId, [kitchen])).size).toBe(0);
		const rows = await db
			.select()
			.from(imageDescriptions)
			.where(eq(imageDescriptions.artifactId, kitchen));
		expect(rows).toEqual([]);
	});

	it("is removed with the person", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId);
		await saveImageDescription({
			userId,
			artifactId: kitchen,
			description: "A small white kitchen with a window.",
			modelName: "qwen3-8-flash-next",
		});

		await db.delete(users).where(eq(users.id, userId));

		const rows = await db
			.select()
			.from(imageDescriptions)
			.where(eq(imageDescriptions.userId, userId));
		expect(rows).toEqual([]);
	});

	it("refuses a description of an artifact that is not there", async () => {
		const userId = await seedUser();

		await expect(
			saveImageDescription({
				userId,
				artifactId: `artifact-${randomUUID()}`,
				description: "A description of nothing.",
				modelName: "qwen3-8-flash-next",
			}),
		).rejects.toThrow();
	});
});
