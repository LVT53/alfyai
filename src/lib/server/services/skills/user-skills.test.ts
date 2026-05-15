import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function seedUsers() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values([
			{ id: "user-1", email: "user-1@example.com", passwordHash: "hash" },
			{ id: "user-2", email: "user-2@example.com", passwordHash: "hash" },
		])
		.run();

	sqlite.close();
}

describe("user skill definitions", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-user-skills-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("keeps private user skills isolated by owner across CRUD operations", async () => {
		seedUsers();
		const {
			createUserSkillDefinition,
			deleteUserSkillDefinition,
			getUserSkillDefinition,
			listUserSkillDefinitions,
			updateUserSkillDefinition,
		} = await import("./user-skills");

		const created = await createUserSkillDefinition("user-1", {
			displayName: "Meeting critic",
			description: "Reviews meeting notes before sending.",
			instructions: "Find weak claims and unclear follow-ups.",
			activationExamples: ["review these notes", "criticize this meeting summary"],
		});

		expect(created).toMatchObject({
			displayName: "Meeting critic",
			description: "Reviews meeting notes before sending.",
			instructions: "Find weak claims and unclear follow-ups.",
			activationExamples: ["review these notes", "criticize this meeting summary"],
			ownership: "user",
			enabled: true,
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
			creationSource: "user_created",
			version: 1,
		});

		await expect(listUserSkillDefinitions("user-1")).resolves.toHaveLength(1);
		await expect(listUserSkillDefinitions("user-2")).resolves.toEqual([]);
		await expect(getUserSkillDefinition("user-2", created.id)).resolves.toBeNull();

		const blockedUpdate = await updateUserSkillDefinition("user-2", created.id, {
			displayName: "Stolen skill",
		});
		expect(blockedUpdate).toBeNull();

		const updated = await updateUserSkillDefinition("user-1", created.id, {
			displayName: "Meeting reviewer",
			enabled: false,
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
		});

		expect(updated).toMatchObject({
			id: created.id,
			displayName: "Meeting reviewer",
			enabled: false,
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			version: 2,
		});

		await expect(deleteUserSkillDefinition("user-2", created.id)).resolves.toBe(false);
		await expect(getUserSkillDefinition("user-1", created.id)).resolves.toMatchObject({
			id: created.id,
		});
		await expect(deleteUserSkillDefinition("user-1", created.id)).resolves.toBe(true);
		await expect(listUserSkillDefinitions("user-1")).resolves.toEqual([]);
	});

	it("seeds the current built-in System Skill taxonomy and exposes only enabled summaries to users", async () => {
		seedUsers();
		const {
			createUserSkillDefinition,
			listAdminSystemSkillDefinitions,
			listEnabledSystemSkillSummaries,
			listUserSkillDefinitions,
			seedBuiltInSystemSkillDefinitions,
			updateSystemSkillDefinition,
		} = await import("./user-skills");

		const privateSkill = await createUserSkillDefinition("user-2", {
			displayName: "Private counsel",
			description: "Only user two should see this body.",
			instructions: "PRIVATE_USER_TWO_INSTRUCTIONS",
			activationExamples: ["private"],
		});

		await seedBuiltInSystemSkillDefinitions("user-1");
		const seeded = await listAdminSystemSkillDefinitions();

		expect(seeded).toHaveLength(6);
		expect(seeded.map((skill) => skill.displayName).sort()).toEqual([
			"Appointment Prep",
			"Document Explainer",
			"Plan Critic",
			"Purchase Helper",
			"Study Coach",
			"Translate & Rewrite",
		]);
		expect(seeded.every((skill) => skill.ownership === "system")).toBe(true);
		expect(seeded.every((skill) => skill.enabled && skill.published)).toBe(true);

		const planCritic = seeded.find((skill) => skill.id === "system:grill-with-docs");
		expect(planCritic?.displayName).toBe("Plan Critic");
		expect(planCritic?.localizedDefaults.hu.displayName).toBe("Tervkritikus");
		const documentExplainer = seeded.find((skill) => skill.id === "system:document-explainer");
		expect(documentExplainer?.localizedDefaults.hu.displayName).toBe("Dokumentummagyarázó");

		const edited = await updateSystemSkillDefinition("system:grill-with-docs", {
			instructions: "Admin-edited plan critic instructions.",
			description: "Admin-edited description.",
		});
		expect(edited).toMatchObject({
			id: "system:grill-with-docs",
			displayName: "Plan Critic",
			instructions: "Admin-edited plan critic instructions.",
			description: "Admin-edited description.",
		});

		await seedBuiltInSystemSkillDefinitions("user-1");
		await expect(listAdminSystemSkillDefinitions()).resolves.toContainEqual(
			expect.objectContaining({
				id: "system:grill-with-docs",
				displayName: "Plan Critic",
				instructions: "Admin-edited plan critic instructions.",
				description: "Admin-edited description.",
			}),
		);

		const summaries = await listEnabledSystemSkillSummaries();
		const serializedSummaries = JSON.stringify(summaries);
		expect(summaries).toHaveLength(6);
		expect(summaries.map((skill) => skill.displayName).sort()).toEqual([
			"Appointment Prep",
			"Document Explainer",
			"Plan Critic",
			"Purchase Helper",
			"Study Coach",
			"Translate & Rewrite",
		]);
		expect(summaries.map((skill) => skill.id)).not.toContain("system:interview");
		expect(serializedSummaries).not.toContain("instructions");
		expect(serializedSummaries).not.toContain("Admin-edited plan critic instructions.");
		expect(serializedSummaries).not.toContain("PRIVATE_USER_TWO_INSTRUCTIONS");
		expect(serializedSummaries).not.toContain("Stress-test the user's plan");
		expect(serializedSummaries).not.toContain("Tedd próbára");
		for (const summary of summaries) {
			expect(summary).not.toHaveProperty("instructions");
			expect(summary.localizedDefaults.en).not.toHaveProperty("instructions");
			expect(summary.localizedDefaults.hu).not.toHaveProperty("instructions");
		}
		await expect(listUserSkillDefinitions("user-1")).resolves.toEqual([]);
		await expect(listUserSkillDefinitions("user-2")).resolves.toContainEqual(
			expect.objectContaining({ id: privateSkill.id, instructions: "PRIVATE_USER_TWO_INSTRUCTIONS" }),
		);
	});

	it("reconciles stale built-in System Skill rows without showing or deleting retired admin edits", async () => {
		seedUsers();
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const legacyDb = drizzle(sqlite, { schema });
		legacyDb
			.insert(schema.userSkillDefinitions)
			.values([
				{
					id: "system:interview",
					userId: "user-1",
					ownership: "system",
					displayName: "Interview",
					description: "Admin-customized retired interview description.",
					instructions: "Admin-customized retired interview instructions.",
					activationExamplesJson: JSON.stringify([
						"interview me first",
						"ask me questions before planning",
					]),
					enabled: true,
					published: true,
					durationPolicy: "next_message",
					questionPolicy: "ask_when_needed",
					notesPolicy: "none",
					sourceScope: "selected_sources_only",
					creationSource: "system_seed",
				},
				{
					id: "system:grill-with-docs",
					userId: "user-1",
					ownership: "system",
					displayName: "Grill With Docs",
					description: "Challenges a plan against attached or selected project documents.",
					instructions: "Admin-edited critic instructions.",
					activationExamplesJson: JSON.stringify([
						"grill this plan with the docs",
						"challenge this against our ADRs",
					]),
					enabled: true,
					published: true,
					durationPolicy: "next_message",
					questionPolicy: "ask_when_needed",
					notesPolicy: "none",
					sourceScope: "selected_sources_only",
					creationSource: "system_seed",
				},
				{
					id: "system:code-review",
					userId: "user-1",
					ownership: "system",
					displayName: "Code Review",
					description: "Reviews code for correctness, regressions, security risks, and missing tests.",
					instructions:
						"Review code from a bug-first perspective. Lead with concrete findings, include file and line references when available, call out missing tests, and keep summaries secondary.",
					activationExamplesJson: JSON.stringify(["review this diff", "find bugs in this change"]),
					enabled: true,
					published: true,
					durationPolicy: "next_message",
					questionPolicy: "ask_when_needed",
					notesPolicy: "none",
					sourceScope: "selected_sources_only",
					creationSource: "system_seed",
				},
			])
			.run();
		sqlite.close();

		const {
			getSystemSkillDefinition,
			listAdminSystemSkillDefinitions,
			listEnabledSystemSkillSummaries,
			seedBuiltInSystemSkillDefinitions,
		} = await import("./user-skills");

		await seedBuiltInSystemSkillDefinitions("user-1");

		const adminSkills = await listAdminSystemSkillDefinitions();
		expect(adminSkills.map((skill) => skill.id).sort()).toEqual([
			"system:appointment-prep",
			"system:document-explainer",
			"system:grill-with-docs",
			"system:purchase-helper",
			"system:study-coach",
			"system:translate-rewrite",
		]);
		await expect(getSystemSkillDefinition("system:interview")).resolves.toMatchObject({
			id: "system:interview",
			displayName: "Interview",
			description: "Admin-customized retired interview description.",
			instructions: "Admin-customized retired interview instructions.",
			enabled: false,
			published: false,
		});
		await expect(getSystemSkillDefinition("system:code-review")).resolves.toMatchObject({
			id: "system:code-review",
			enabled: false,
			published: false,
		});

		const planCritic = await getSystemSkillDefinition("system:grill-with-docs");
		expect(planCritic).toMatchObject({
			displayName: "Plan Critic",
			description: "Stress-tests a plan against attached or selected project documents.",
			instructions: "Admin-edited critic instructions.",
			activationExamples: ["criticize this plan", "challenge this against our ADRs"],
			questionPolicy: "ask_when_needed",
		});

		const summaries = await listEnabledSystemSkillSummaries();
		const serializedSummaries = JSON.stringify(summaries);
		expect(summaries).toHaveLength(6);
		expect(serializedSummaries).not.toContain("Interview");
		expect(serializedSummaries).not.toContain("Grill With Docs");
		expect(serializedSummaries).not.toContain("Code Review");
	});

	it("uses a stable admin owner when a normal user triggers missing built-in seeding", async () => {
		seedUsers();
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const seedDb = drizzle(sqlite, { schema });
		seedDb.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, "user-2")).run();
		sqlite.close();

		const { seedBuiltInSystemSkillDefinitions } = await import("./user-skills");
		const { db } = await import("$lib/server/db");

		await seedBuiltInSystemSkillDefinitions("user-1");

		const systemRows = await db
			.select({
				id: schema.userSkillDefinitions.id,
				userId: schema.userSkillDefinitions.userId,
			})
			.from(schema.userSkillDefinitions)
			.where(eq(schema.userSkillDefinitions.ownership, "system"));

		expect(systemRows).toHaveLength(6);
		expect(new Set(systemRows.map((row) => row.userId))).toEqual(new Set(["user-2"]));
	});

	it("discovers available skills with user skills outranking equal system matches", async () => {
		seedUsers();
		const {
			createSystemSkillDefinition,
			createUserSkillDefinition,
			discoverSkillSummaries,
			seedBuiltInSystemSkillDefinitions,
			updateSystemSkillDefinition,
			updateUserSkillDefinition,
		} = await import("./user-skills");

		const disabled = await createUserSkillDefinition("user-1", {
			displayName: "Hidden interview helper",
			description: "Should not appear.",
			instructions: "Hidden.",
			activationExamples: ["interview"],
			enabled: false,
		});
		const userDescriptionMatch = await createUserSkillDefinition("user-1", {
			displayName: "Planning partner",
			description: "Helps with interview preparation.",
			instructions: "Help plan interviews.",
			activationExamples: ["prep"],
		});
		const userNameMatch = await createUserSkillDefinition("user-1", {
			displayName: "Interview coach",
			description: "Private interview skill.",
			instructions: "Coach interview answers.",
			activationExamples: ["practice"],
		});
		await createUserSkillDefinition("user-2", {
			displayName: "Interview private to another user",
			description: "Should not appear.",
			instructions: "Private.",
			activationExamples: ["interview"],
		});
		await seedBuiltInSystemSkillDefinitions("user-1");
		await updateSystemSkillDefinition("system:study-coach", { published: false });
		await createSystemSkillDefinition("user-1", {
			displayName: "Interview draft",
			description: "Unpublished system skill.",
			instructions: "Hidden.",
			activationExamples: ["interview"],
			published: false,
		});
		await updateUserSkillDefinition("user-1", disabled.id, { enabled: false });

		await expect(discoverSkillSummaries("user-1", "interview")).resolves.toEqual([
			expect.objectContaining({ id: userNameMatch.id, ownership: "user" }),
			expect.objectContaining({ id: userDescriptionMatch.id, ownership: "user" }),
		]);
		const discovered = await discoverSkillSummaries("user-1", "interview");
		const serialized = JSON.stringify(discovered);
		expect(discovered.map((skill) => skill.id)).not.toContain(disabled.id);
		expect(discovered.map((skill) => skill.id)).not.toContain("system:study-coach");
		expect(serialized).not.toContain("instructions");
	});
});
