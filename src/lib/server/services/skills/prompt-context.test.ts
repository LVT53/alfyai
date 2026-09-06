import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
// Pure, DB-free helpers are safe to import statically. The DB-touching
// functions (listSkillCatalogueEntries, resolveSkillInstructionsForUse,
// resolvePendingSkillApplication) are imported dynamically inside each test
// instead — like user-skills.test.ts's own pattern — because they transitively
// pull in $lib/server/db, which reads DATABASE_PATH at import time; importing
// them statically here would bind them to whichever DATABASE_PATH happened to
// be set when this file first loaded, not the per-test path set in beforeEach.
import {
	buildSkillCatalogueBlock,
	buildSkillInstructionsEnvelope,
	SKILLS_AVAILABLE_HEADING,
	selectSkillResources,
} from "./prompt-context";

let dbPath: string;

function seedUsers() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values([
			{ id: "user-1", email: "user-1@example.com", passwordHash: "hash" },
		])
		.run();

	sqlite.close();
}

describe("skills/prompt-context", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-prompt-context-${randomUUID()}.db`;
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

	describe("selectSkillResources", () => {
		it("always includes guidance resources and matches domain templates by keyword, capped at 3", () => {
			const resources = [
				{
					id: "guidance-1",
					title: "Always guidance",
					kind: "guidance" as const,
					summary: "s",
					whenToUse: "w",
					content: "Always included content.",
					keywords: [],
				},
				{
					id: "template-finance",
					title: "Finance template",
					kind: "domain_template" as const,
					summary: "s",
					whenToUse: "w",
					content: "Finance-specific content.",
					keywords: ["budget", "forecast"],
				},
				{
					id: "template-marketing",
					title: "Marketing template",
					kind: "domain_template" as const,
					summary: "s",
					whenToUse: "w",
					content: "Marketing-specific content.",
					keywords: ["campaign"],
				},
			];

			const selected = selectSkillResources(resources, "Build a budget model");

			expect(selected.map((r) => r.id)).toEqual([
				"guidance-1",
				"template-finance",
			]);
		});

		it("returns an empty list when there are no resources", () => {
			expect(selectSkillResources(undefined, "anything")).toEqual([]);
			expect(selectSkillResources([], "anything")).toEqual([]);
		});
	});

	describe("buildSkillInstructionsEnvelope", () => {
		it("frames instructions with the skill name and appends selected resources", () => {
			const envelope = buildSkillInstructionsEnvelope({
				displayName: "Plan Critic",
				instructions: "Find the blockers first.",
				resources: [
					{
						id: "r1",
						title: "Severity guide",
						content: "Tag Blocker/Major/Minor.",
					},
				],
			});

			expect(envelope).toContain(
				'Skill "Plan Critic" instructions — apply these for the rest of this turn:',
			);
			expect(envelope).toContain("Find the blockers first.");
			expect(envelope).toContain("Additional skill resources:");
			expect(envelope).toContain("Severity guide: Tag Blocker/Major/Minor.");
		});

		it("omits the resources section when there are none", () => {
			const envelope = buildSkillInstructionsEnvelope({
				displayName: "Study Coach",
				instructions: "Coach actively.",
				resources: [],
			});

			expect(envelope).not.toContain("Additional skill resources:");
		});
	});

	describe("buildSkillCatalogueBlock", () => {
		it("returns null for an empty catalogue", () => {
			expect(buildSkillCatalogueBlock([])).toBeNull();
		});

		it("renders one line per skill under the heading", () => {
			const block = buildSkillCatalogueBlock([
				{
					id: "system:plan-critic",
					ownership: "system",
					displayName: "Plan Critic",
					description: "Finds the blockers in a plan.",
				} as never,
				{
					id: "user-skill-1",
					ownership: "user",
					displayName: "Custom Skill",
					description: "A user-authored skill.",
				} as never,
			]);

			expect(block).toContain(SKILLS_AVAILABLE_HEADING);
			expect(block).toContain("Plan Critic — Finds the blockers in a plan.");
			expect(block).toContain("Custom Skill — A user-authored skill.");
		});

		it("caps the catalogue at 15 lines and ~1,400 characters, truncating descriptions not names", () => {
			const manySkills = Array.from({ length: 20 }, (_, index) => ({
				id: `skill-${index}`,
				ownership: "user" as const,
				displayName: `Skill Number ${index}`,
				description:
					"A very long description that goes on and on to force truncation logic to kick in for this catalogue line entry.",
			})) as never[];

			const block = buildSkillCatalogueBlock(manySkills);
			expect(block).not.toBeNull();
			if (!block) return;

			const lines = block.split("\n");
			// heading + at most 15 skill lines
			expect(lines.length).toBeLessThanOrEqual(16);
			expect(block.length).toBeLessThanOrEqual(1500);
			// Every included skill's name survives in full (only descriptions
			// are truncated).
			for (const line of lines.slice(1)) {
				const name = line.replace(/^- /, "").split(" — ")[0];
				expect(name?.startsWith("Skill Number")).toBe(true);
			}
		});
	});

	describe("listSkillCatalogueEntries + resolveSkillInstructionsForUse (use_skill tool backing)", () => {
		it("returns the skill's full instructions when the name matches an enabled skill", async () => {
			seedUsers();
			const { createUserSkillDefinition } = await import("./user-skills");
			const { listSkillCatalogueEntries, resolveSkillInstructionsForUse } =
				await import("./prompt-context");
			await createUserSkillDefinition("user-1", {
				displayName: "Meeting Recap",
				description: "Summarizes meeting notes into action items.",
				instructions: "Extract decisions, owners, and deadlines.",
				enabled: true,
			});

			const entries = await listSkillCatalogueEntries("user-1");
			expect(entries.map((entry) => entry.displayName)).toContain(
				"Meeting Recap",
			);

			const result = await resolveSkillInstructionsForUse({
				userId: "user-1",
				name: "Meeting Recap",
				requestText: "Summarize today's meeting",
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.displayName).toBe("Meeting Recap");
			expect(result.envelope).toContain(
				"Extract decisions, owners, and deadlines.",
			);
			expect(result.envelope).toContain('Skill "Meeting Recap" instructions');
		});

		it("matches slug-style names and the id tail the model tends to write", async () => {
			seedUsers();
			const { createUserSkillDefinition } = await import("./user-skills");
			const { resolveSkillInstructionsForUse } = await import(
				"./prompt-context"
			);
			await createUserSkillDefinition("user-1", {
				displayName: "Plan Critic",
				description: "d",
				instructions: "i",
				enabled: true,
			});
			for (const name of [
				"plan-critic",
				"plan_critic",
				"PLAN CRITIC",
				"plancritic",
			]) {
				const result = await resolveSkillInstructionsForUse({
					userId: "user-1",
					name,
					requestText: "",
				});
				expect(result.ok, name).toBe(true);
			}
			const miss = await resolveSkillInstructionsForUse({
				userId: "user-1",
				name: "plan-critique",
				requestText: "",
			});
			expect(miss.ok).toBe(false);
		});

		it("matches case-insensitively by id as well as display name", async () => {
			seedUsers();
			const { createUserSkillDefinition } = await import("./user-skills");
			const { resolveSkillInstructionsForUse } = await import(
				"./prompt-context"
			);
			const created = await createUserSkillDefinition("user-1", {
				displayName: "Case Test Skill",
				description: "d",
				instructions: "i",
				enabled: true,
			});

			const byId = await resolveSkillInstructionsForUse({
				userId: "user-1",
				name: created.id.toUpperCase(),
				requestText: "",
			});
			expect(byId.ok).toBe(true);

			const byName = await resolveSkillInstructionsForUse({
				userId: "user-1",
				name: "case test skill",
				requestText: "",
			});
			expect(byName.ok).toBe(true);
		});

		it("returns a not_found error for an unknown skill name", async () => {
			seedUsers();
			const { resolveSkillInstructionsForUse } = await import(
				"./prompt-context"
			);

			const result = await resolveSkillInstructionsForUse({
				userId: "user-1",
				name: "Nonexistent Skill",
				requestText: "",
			});

			expect(result).toEqual({ ok: false, reason: "not_found" });
		});

		it("excludes a disabled skill from the catalogue and refuses to load it by name", async () => {
			seedUsers();
			const { createUserSkillDefinition } = await import("./user-skills");
			const { listSkillCatalogueEntries, resolveSkillInstructionsForUse } =
				await import("./prompt-context");
			await createUserSkillDefinition("user-1", {
				displayName: "Disabled Skill",
				description: "d",
				instructions: "i",
				enabled: false,
			});

			const entries = await listSkillCatalogueEntries("user-1");
			expect(entries.map((entry) => entry.displayName)).not.toContain(
				"Disabled Skill",
			);

			const result = await resolveSkillInstructionsForUse({
				userId: "user-1",
				name: "Disabled Skill",
				requestText: "",
			});
			expect(result).toEqual({ ok: false, reason: "not_found" });
		});
	});

	describe("resolvePendingSkillApplication (forced `$` selection)", () => {
		it("returns the same envelope shape use_skill would return, for the exact selected skill", async () => {
			seedUsers();
			const { createUserSkillDefinition } = await import("./user-skills");
			const { resolvePendingSkillApplication } = await import(
				"./prompt-context"
			);
			const created = await createUserSkillDefinition("user-1", {
				displayName: "Forced Skill",
				description: "d",
				instructions: "Follow this exactly.",
				enabled: true,
			});

			const result = await resolvePendingSkillApplication({
				userId: "user-1",
				pendingSkill: {
					id: created.id,
					ownership: "user",
					displayName: "Forced Skill",
				},
				requestText: "do the thing",
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.envelope).toContain("Follow this exactly.");
		});

		it("reports unavailable when the selected skill was disabled after selection", async () => {
			seedUsers();
			const { createUserSkillDefinition, updateUserSkillDefinition } =
				await import("./user-skills");
			const { resolvePendingSkillApplication } = await import(
				"./prompt-context"
			);
			const created = await createUserSkillDefinition("user-1", {
				displayName: "Now Disabled",
				description: "d",
				instructions: "i",
				enabled: true,
			});
			await updateUserSkillDefinition("user-1", created.id, { enabled: false });

			const result = await resolvePendingSkillApplication({
				userId: "user-1",
				pendingSkill: {
					id: created.id,
					ownership: "user",
					displayName: "Now Disabled",
				},
				requestText: "",
			});

			expect(result).toEqual({ ok: false, reason: "disabled" });
		});
	});
});
