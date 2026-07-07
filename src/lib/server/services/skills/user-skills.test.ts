import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
			activationExamples: [
				"review these notes",
				"criticize this meeting summary",
			],
		});

		expect(created).toMatchObject({
			displayName: "Meeting critic",
			description: "Reviews meeting notes before sending.",
			instructions: "Find weak claims and unclear follow-ups.",
			activationExamples: [
				"review these notes",
				"criticize this meeting summary",
			],
			ownership: "user",
			enabled: true,
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
			creationSource: "user_created",
			skillKind: "user_skill",
			version: 1,
		});

		await expect(listUserSkillDefinitions("user-1")).resolves.toHaveLength(1);
		await expect(listUserSkillDefinitions("user-2")).resolves.toEqual([]);
		await expect(
			getUserSkillDefinition("user-2", created.id),
		).resolves.toBeNull();

		const blockedUpdate = await updateUserSkillDefinition(
			"user-2",
			created.id,
			{
				displayName: "Stolen skill",
			},
		);
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

		await expect(deleteUserSkillDefinition("user-2", created.id)).resolves.toBe(
			false,
		);
		await expect(
			getUserSkillDefinition("user-1", created.id),
		).resolves.toMatchObject({
			id: created.id,
		});
		await expect(deleteUserSkillDefinition("user-1", created.id)).resolves.toBe(
			true,
		);
		await expect(listUserSkillDefinitions("user-1")).resolves.toEqual([]);
	});

	it("seeds the current built-in System Skill taxonomy and exposes only enabled summaries to users", async () => {
		seedUsers();
		const {
			createUserSkillDefinition,
			listAdminSystemSkillDefinitions,
			listEnabledSystemSkillSummaries,
			listUserSkillDefinitions,
			localizeSystemSkillSummary,
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

		expect(seeded).toHaveLength(7);
		expect(seeded.map((skill) => skill.displayName).sort()).toEqual([
			"Appointment Prep",
			"Document Explainer",
			"Plan Critic",
			"Purchase Helper",
			"Spreadsheet Builder",
			"Study Coach",
			"Translate & Rewrite",
		]);
		expect(seeded.every((skill) => skill.ownership === "system")).toBe(true);
		expect(seeded.every((skill) => skill.skillKind === "skill_pack")).toBe(
			true,
		);
		expect(seeded.every((skill) => skill.enabled && skill.published)).toBe(
			true,
		);

		const planCritic = seeded.find(
			(skill) => skill.id === "system:grill-with-docs",
		);
		expect(planCritic?.displayName).toBe("Plan Critic");
		expect(planCritic?.localizedDefaults.hu.displayName).toBe("Tervkritikus");
		const documentExplainer = seeded.find(
			(skill) => skill.id === "system:document-explainer",
		);
		expect(documentExplainer?.localizedDefaults.hu.displayName).toBe(
			"Dokumentummagyarázó",
		);
		const spreadsheetBuilder = seeded.find(
			(skill) => skill.id === "system:spreadsheet-builder",
		);
		expect(spreadsheetBuilder).toMatchObject({
			displayName: "Spreadsheet Builder",
			description:
				"Creates polished XLSX workbooks with formulas, tables, assumptions, dashboards, and AlfyAI file-production delivery.",
			localizedDefaults: {
				hu: {
					displayName: "Táblázatkészítő",
					description:
						"Átgondolt XLSX munkafüzeteket készít képletekkel, táblákkal, feltételezésekkel, irányítópultokkal és AlfyAI fájl-előállítással.",
				},
			},
			managedResources: expect.arrayContaining([
				expect.objectContaining({
					id: "spreadsheet-style-quality",
					title: "Spreadsheet style and workbook quality",
					kind: "guidance",
				}),
				expect.objectContaining({
					id: "spreadsheet-finance-models",
					title: "Finance and operating model conventions",
					kind: "domain_template",
				}),
			]),
		});
		expect(JSON.stringify(spreadsheetBuilder)).not.toContain(
			"Use native Excel charts",
		);

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
		expect(summaries).toHaveLength(7);
		expect(summaries.map((skill) => skill.displayName).sort()).toEqual([
			"Appointment Prep",
			"Document Explainer",
			"Plan Critic",
			"Purchase Helper",
			"Spreadsheet Builder",
			"Study Coach",
			"Translate & Rewrite",
		]);
		expect(summaries.map((skill) => skill.id)).not.toContain(
			"system:interview",
		);
		const documentExplainerSummary = summaries.find(
			(skill) => skill.id === "system:document-explainer",
		);
		if (!documentExplainerSummary) {
			throw new Error("Expected seeded document explainer summary.");
		}
		expect(
			localizeSystemSkillSummary(documentExplainerSummary, "hu"),
		).toMatchObject({
			displayName: "Dokumentummagyarázó",
			description:
				"Kijelölt dokumentumokat magyaráz el érthetően, a forrástényeket, fenntartásokat és szerkezetet megőrizve.",
		});
		const spreadsheetSummary = summaries.find(
			(skill) => skill.id === "system:spreadsheet-builder",
		);
		if (!spreadsheetSummary) {
			throw new Error("Expected seeded spreadsheet builder summary.");
		}
		expect(localizeSystemSkillSummary(spreadsheetSummary, "hu")).toMatchObject({
			displayName: "Táblázatkészítő",
			description:
				"Átgondolt XLSX munkafüzeteket készít képletekkel, táblákkal, feltételezésekkel, irányítópultokkal és AlfyAI fájl-előállítással.",
		});
		const planCriticSummary = summaries.find(
			(skill) => skill.id === "system:grill-with-docs",
		);
		if (!planCriticSummary) {
			throw new Error("Expected seeded plan critic summary.");
		}
		expect(localizeSystemSkillSummary(planCriticSummary, "hu")).toMatchObject({
			displayName: "Tervkritikus",
			description: "Admin-edited description.",
		});
		expect(serializedSummaries).not.toContain("instructions");
		expect(serializedSummaries).not.toContain(
			"Admin-edited plan critic instructions.",
		);
		expect(serializedSummaries).not.toContain("PRIVATE_USER_TWO_INSTRUCTIONS");
		expect(serializedSummaries).not.toContain("Stress-test the user's plan");
		expect(serializedSummaries).not.toContain("Tedd próbára");
		expect(serializedSummaries).not.toContain("sourceMode");
		expect(serializedSummaries).not.toContain("spreadsheet-finance-models");
		for (const summary of summaries) {
			expect(summary.skillKind).toBe("skill_pack");
			expect(summary).not.toHaveProperty("instructions");
			expect(summary).not.toHaveProperty("managedResources");
			expect(summary.localizedDefaults.en).not.toHaveProperty("instructions");
			expect(summary.localizedDefaults.hu).not.toHaveProperty("instructions");
		}
		await expect(listUserSkillDefinitions("user-1")).resolves.toEqual([]);
		await expect(listUserSkillDefinitions("user-2")).resolves.toContainEqual(
			expect.objectContaining({
				id: privateSkill.id,
				instructions: "PRIVATE_USER_TWO_INSTRUCTIONS",
			}),
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
					description:
						"Challenges a plan against attached or selected project documents.",
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
					description:
						"Reviews code for correctness, regressions, security risks, and missing tests.",
					instructions:
						"Review code from a bug-first perspective. Lead with concrete findings, include file and line references when available, call out missing tests, and keep summaries secondary.",
					activationExamplesJson: JSON.stringify([
						"review this diff",
						"find bugs in this change",
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
					id: "system:purchase-helper",
					userId: "user-1",
					ownership: "system",
					displayName: "Purchase Helper",
					description:
						"Compares buying options against needs, constraints, tradeoffs, and current facts.",
					instructions:
						"Help the user make a purchase decision. Clarify needs and constraints when needed, compare options by practical tradeoffs, flag uncertainty or freshness-sensitive facts, and avoid overconfident recommendations.",
					activationExamplesJson: JSON.stringify([
						"help me choose what to buy",
						"compare these options",
					]),
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
			"system:spreadsheet-builder",
			"system:study-coach",
			"system:translate-rewrite",
		]);
		await expect(
			getSystemSkillDefinition("system:interview"),
		).resolves.toMatchObject({
			id: "system:interview",
			displayName: "Interview",
			description: "Admin-customized retired interview description.",
			instructions: "Admin-customized retired interview instructions.",
			enabled: false,
			published: false,
		});
		await expect(
			getSystemSkillDefinition("system:code-review"),
		).resolves.toMatchObject({
			id: "system:code-review",
			enabled: false,
			published: false,
		});

		const planCritic = await getSystemSkillDefinition("system:grill-with-docs");
		expect(planCritic).toMatchObject({
			displayName: "Plan Critic",
			description:
				"Stress-tests plans against selected sources, product language, constraints, and implementation reality.",
			instructions: "Admin-edited critic instructions.",
			activationExamples: [
				"criticize this plan",
				"challenge this against our ADRs",
				"stress-test this implementation plan",
				"find the weak assumptions",
			],
			questionPolicy: "ask_when_needed",
		});
		await expect(
			getSystemSkillDefinition("system:purchase-helper"),
		).resolves.toMatchObject({
			description:
				"Compares buying options against user needs, constraints, tradeoffs, risks, and current evidence.",
			activationExamples: [
				"help me choose what to buy",
				"compare these options",
				"which option fits my needs",
				"make a buying decision matrix",
			],
		});

		const summaries = await listEnabledSystemSkillSummaries();
		const serializedSummaries = JSON.stringify(summaries);
		expect(summaries).toHaveLength(7);
		expect(serializedSummaries).not.toContain("Interview");
		expect(serializedSummaries).not.toContain("Grill With Docs");
		expect(serializedSummaries).not.toContain("Code Review");
	});

	it("refreshes unedited seeded System Skill defaults to the stronger built-in workflows", async () => {
		seedUsers();
		const {
			getSystemSkillDefinition,
			seedBuiltInSystemSkillDefinitions,
			updateSystemSkillDefinition,
		} = await import("./user-skills");

		await seedBuiltInSystemSkillDefinitions("user-1");
		const seededPurchaseHelper = await getSystemSkillDefinition(
			"system:purchase-helper",
		);
		expect(seededPurchaseHelper).toMatchObject({
			description:
				"Compares buying options against user needs, constraints, tradeoffs, risks, and current evidence.",
			activationExamples: [
				"help me choose what to buy",
				"compare these options",
				"which option fits my needs",
				"make a buying decision matrix",
			],
		});
		expect(seededPurchaseHelper?.instructions).toContain(
			"not a generic best-product ranking",
		);
		expect(seededPurchaseHelper?.instructions).toContain(
			"Treat prices, availability, laws, insurance terms, and product specifications as freshness-sensitive.",
		);

		await updateSystemSkillDefinition("system:document-explainer", {
			instructions: "Admin-customized document instructions.",
			description: "Admin-customized document description.",
		});
		await seedBuiltInSystemSkillDefinitions("user-1");

		await expect(
			getSystemSkillDefinition("system:document-explainer"),
		).resolves.toMatchObject({
			description: "Admin-customized document description.",
			instructions: "Admin-customized document instructions.",
		});
	});

	it("uses a stable admin owner when a normal user triggers missing built-in seeding", async () => {
		seedUsers();
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const seedDb = drizzle(sqlite, { schema });
		seedDb
			.update(schema.users)
			.set({ role: "admin" })
			.where(eq(schema.users.id, "user-2"))
			.run();
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

		expect(systemRows).toHaveLength(7);
		expect(new Set(systemRows.map((row) => row.userId))).toEqual(
			new Set(["user-2"]),
		);
	});

	it("seeds the spreadsheet pack with AlfyAI-native file-production guidance and no Codex runtime promises", async () => {
		seedUsers();
		const {
			resolveEffectiveSkillDefinition,
			seedBuiltInSystemSkillDefinitions,
		} = await import("./user-skills");

		await seedBuiltInSystemSkillDefinitions("user-1");
		const spreadsheetPack = await resolveEffectiveSkillDefinition("user-1", {
			id: "system:spreadsheet-builder",
			ownership: "system",
		});

		expect(spreadsheetPack).toMatchObject({
			available: true,
			skillKind: "skill_pack",
			displayName: "Spreadsheet Builder",
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			sourceScope: "selected_sources_only",
			promptResources: [
				expect.objectContaining({ id: "spreadsheet-style-quality" }),
				expect.objectContaining({ id: "spreadsheet-finance-models" }),
				expect.objectContaining({ id: "spreadsheet-healthcare-admin" }),
				expect.objectContaining({ id: "spreadsheet-marketing-analytics" }),
				expect.objectContaining({ id: "spreadsheet-scientific-research" }),
			],
		});
		if (!spreadsheetPack.available) {
			throw new Error("Expected spreadsheet pack to be available.");
		}
		const contractText = [
			spreadsheetPack.effectiveInstructions,
			...spreadsheetPack.promptResources.map((resource) => resource.content),
		].join("\n");
		for (const required of [
			"produce_file",
			'sourceMode: "program"',
			'language: "javascript"',
			'requestedOutputs: [{ "type": "xlsx" }]',
			"program: {",
			"sourceCode",
			"filename",
			"idempotencyKey",
			"requestTitle",
			"documentIntent",
			"exceljs",
			"/output",
			'workbook.xlsx.writeFile("/output/<name>.xlsx")',
			"workbook.calcProperties.fullCalcOnLoad = true",
			"chart-ready helper tables",
		]) {
			expect(contractText).toContain(required);
		}
		for (const forbidden of [
			"Google Drive",
			"@oai/artifact-tool",
			"artifact-tool",
			"Markdown link",
			"native Excel chart",
			"chart objects",
			"sheet.charts",
			"npm install",
			"network fetch",
			"Excel/LibreOffice",
			"browser API",
			"openpyxl",
			"xlsxwriter",
			"pandas.ExcelWriter",
			"post-job visual QA",
		]) {
			expect(contractText).not.toContain(forbidden);
		}
		expect(contractText.length).toBeLessThan(9000);
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
		await updateSystemSkillDefinition("system:study-coach", {
			published: false,
		});
		await createSystemSkillDefinition("user-1", {
			displayName: "Interview draft",
			description: "Unpublished system skill.",
			instructions: "Hidden.",
			activationExamples: ["interview"],
			published: false,
		});
		await updateUserSkillDefinition("user-1", disabled.id, { enabled: false });

		await expect(
			discoverSkillSummaries("user-1", "interview"),
		).resolves.toEqual([
			expect.objectContaining({ id: userNameMatch.id, ownership: "user" }),
			expect.objectContaining({
				id: userDescriptionMatch.id,
				ownership: "user",
			}),
		]);
		const discovered = await discoverSkillSummaries("user-1", "interview");
		const serialized = JSON.stringify(discovered);
		expect(discovered.map((skill) => skill.id)).not.toContain(disabled.id);
		expect(discovered.map((skill) => skill.id)).not.toContain(
			"system:study-coach",
		);
		expect(serialized).not.toContain("instructions");
	});

	it("creates, lists, updates, and deletes overlay-only user variants without mutating their pack", async () => {
		seedUsers();
		const {
			createSystemSkillDefinition,
			createUserSkillVariantDefinition,
			deleteUserSkillVariantDefinition,
			getUserSkillVariantDefinition,
			listUserSkillVariantDefinitions,
			updateUserSkillVariantDefinition,
		} = await import("./user-skills");
		const { db } = await import("$lib/server/db");

		const pack = await createSystemSkillDefinition("user-1", {
			displayName: "Research Pack",
			description: "Grounded research.",
			instructions: "PACK_BASE_SECRET",
			activationExamples: ["research this"],
			published: true,
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
		});

		const variant = await createUserSkillVariantDefinition("user-1", {
			baseSkillId: pack.id,
			displayName: "Research Pack, terse",
			description: "Use my executive voice.",
			instructions: "OVERLAY_ONLY_SECRET",
			activationExamples: ["research tersely"],
			enabled: true,
		});

		expect(variant).toMatchObject({
			ownership: "user",
			skillKind: "skill_variant",
			baseSkillId: pack.id,
			baseSkillDisplayName: "Research Pack",
			baseSkillAvailable: true,
			displayName: "Research Pack, terse",
			instructions: "OVERLAY_ONLY_SECRET",
			activationExamples: ["research tersely"],
			enabled: true,
			durationPolicy: "next_message",
			notesPolicy: "none",
		});
		expect(variant.instructions).not.toContain("PACK_BASE_SECRET");

		await expect(listUserSkillVariantDefinitions("user-1")).resolves.toEqual([
			expect.objectContaining({
				id: variant.id,
				baseSkillDisplayName: "Research Pack",
				baseSkillAvailable: true,
			}),
		]);
		await expect(
			getUserSkillVariantDefinition("user-2", variant.id),
		).resolves.toBeNull();

		const updated = await updateUserSkillVariantDefinition(
			"user-1",
			variant.id,
			{
				displayName: "Research Pack, board style",
				instructions: "UPDATED_OVERLAY_ONLY",
				enabled: false,
			},
		);
		expect(updated).toMatchObject({
			id: variant.id,
			displayName: "Research Pack, board style",
			instructions: "UPDATED_OVERLAY_ONLY",
			enabled: false,
			version: 2,
		});

		const packRow = await db
			.select()
			.from(schema.userSkillDefinitions)
			.where(eq(schema.userSkillDefinitions.id, pack.id))
			.get();
		expect(packRow).toMatchObject({
			instructions: "PACK_BASE_SECRET",
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			version: 1,
		});

		await expect(
			deleteUserSkillVariantDefinition("user-2", variant.id),
		).resolves.toBe(false);
		await expect(
			deleteUserSkillVariantDefinition("user-1", variant.id),
		).resolves.toBe(true);
		await expect(listUserSkillVariantDefinitions("user-1")).resolves.toEqual(
			[],
		);
	});

	it("discovers available variants with pack identity while suppressing variants whose pack is unavailable", async () => {
		seedUsers();
		const {
			createSystemSkillDefinition,
			createUserSkillVariantDefinition,
			discoverSkillSummaries,
			updateSystemSkillDefinition,
		} = await import("./user-skills");

		const pack = await createSystemSkillDefinition("user-1", {
			displayName: "Interview Pack",
			description: "Practice interviews.",
			instructions: "PACK_DISCOVERY_SECRET",
			activationExamples: ["interview"],
			published: true,
		});
		const variant = await createUserSkillVariantDefinition("user-1", {
			baseSkillId: pack.id,
			displayName: "Interview Pack, concise",
			description: "Practice interviews with concise answers.",
			instructions: "VARIANT_DISCOVERY_SECRET",
			activationExamples: ["interview"],
		});

		const discovered = await discoverSkillSummaries("user-1", "interview");
		expect(discovered).toEqual([
			expect.objectContaining({
				id: variant.id,
				ownership: "user",
				skillKind: "skill_variant",
				baseSkillId: pack.id,
				baseSkillDisplayName: "Interview Pack",
			}),
			expect.objectContaining({
				id: pack.id,
				ownership: "system",
				skillKind: "skill_pack",
			}),
		]);
		expect(JSON.stringify(discovered)).not.toContain("PACK_DISCOVERY_SECRET");
		expect(JSON.stringify(discovered)).not.toContain(
			"VARIANT_DISCOVERY_SECRET",
		);

		await updateSystemSkillDefinition(pack.id, { published: false });
		await expect(
			discoverSkillSummaries("user-1", "interview"),
		).resolves.toEqual([]);
	});

	it("matches variants by base pack name while user-hidden packs suppress only direct pack discovery", async () => {
		seedUsers();
		const {
			createSystemSkillDefinition,
			createUserSkillVariantDefinition,
			discoverSkillSummaries,
			listEnabledSystemSkillSummaries,
			resolveEffectiveSkillDefinition,
			setSystemSkillPackHiddenForUser,
		} = await import("./user-skills");

		const pack = await createSystemSkillDefinition("user-1", {
			displayName: "Research Pack",
			description: "Grounded source research.",
			instructions: "PACK_SECRET",
			activationExamples: ["research"],
			published: true,
		});
		const variant = await createUserSkillVariantDefinition("user-1", {
			baseSkillId: pack.id,
			displayName: "Board-ready voice",
			description: "Write in a terse executive style.",
			instructions: "Use the user's preferred board memo tone.",
			activationExamples: [],
		});

		await expect(discoverSkillSummaries("user-1", "research")).resolves.toEqual(
			[
				expect.objectContaining({
					id: variant.id,
					ownership: "user",
					skillKind: "skill_variant",
					baseSkillId: pack.id,
					baseSkillDisplayName: "Research Pack",
				}),
				expect.objectContaining({
					id: pack.id,
					ownership: "system",
					skillKind: "skill_pack",
				}),
			],
		);

		await setSystemSkillPackHiddenForUser("user-1", pack.id, true);

		await expect(
			listEnabledSystemSkillSummaries("user-1"),
		).resolves.not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: pack.id })]),
		);
		await expect(discoverSkillSummaries("user-1", "research")).resolves.toEqual(
			[
				expect.objectContaining({
					id: variant.id,
					ownership: "user",
					skillKind: "skill_variant",
					baseSkillId: pack.id,
				}),
			],
		);
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: pack.id,
				ownership: "system",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "hidden",
			effectiveInstructions: "",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: variant.id,
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: true,
			skillKind: "skill_variant",
			sourceIds: {
				packSkillId: pack.id,
				variantSkillId: variant.id,
			},
		});
	});

	it("localizes a variant base pack name when the pack defaults are available", async () => {
		const { localizeSkillDiscoverySummary } = await import("./user-skills");

		expect(
			localizeSkillDiscoverySummary(
				{
					id: "variant-1",
					ownership: "user",
					skillKind: "skill_variant",
					baseSkillId: "system:spreadsheet-builder",
					baseSkillVersion: 2,
					baseSkillDisplayName: "Spreadsheet Builder",
					baseSkillLocalizedDefaults: {
						en: {
							displayName: "Spreadsheet Builder",
							description: "Creates polished XLSX workbooks.",
						},
						hu: {
							displayName: "Táblázatkészítő",
							description: "XLSX munkafüzeteket készít.",
						},
					},
					displayName: "My monthly workbook",
					description: "User overlay.",
					activationExamples: [],
					enabled: true,
					durationPolicy: "next_message",
					questionPolicy: "none",
					notesPolicy: "none",
					sourceScope: "selected_sources_only",
					creationSource: "user_created",
					version: 1,
					createdAt: 1,
					updatedAt: 2,
				},
				"hu",
			),
		).toMatchObject({
			baseSkillDisplayName: "Táblázatkészítő",
		});
	});

	it("resolves effective skill context for direct packs, standalone user skills, and pack-backed variants", async () => {
		seedUsers();
		const {
			createSystemSkillDefinition,
			createUserSkillDefinition,
			resolveEffectiveSkillDefinition,
			updateSystemSkillDefinition,
		} = await import("./user-skills");
		const { db } = await import("$lib/server/db");

		const pack = await createSystemSkillDefinition("user-1", {
			displayName: "Research Pack",
			description: "Grounds answers in selected sources.",
			instructions: "BASE_V1: Use only selected sources.",
			activationExamples: ["research this"],
			published: true,
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
		});
		const standalone = await createUserSkillDefinition("user-1", {
			displayName: "Private Coach",
			description: "Personal guidance.",
			instructions: "USER_ONLY: Coach privately.",
			durationPolicy: "session",
			notesPolicy: "create_private_notes",
		});
		await db
			.insert(schema.userSkillDefinitions)
			.values({
				id: "variant-1",
				userId: "user-1",
				ownership: "user",
				skillKind: "skill_variant",
				baseSkillId: pack.id,
				baseSkillVersion: pack.version,
				displayName: "Research Pack with my voice",
				description: "Personal overlay.",
				instructions: "OVERLAY_V1: Use a terse executive voice.",
				activationExamplesJson: JSON.stringify(["research in my voice"]),
				enabled: true,
				published: false,
				durationPolicy: "session",
				questionPolicy: "none",
				notesPolicy: "create_private_notes",
				sourceScope: "current_conversation",
				creationSource: "user_created",
			})
			.run();

		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: pack.id,
				ownership: "system",
			}),
		).resolves.toMatchObject({
			available: true,
			availabilityReason: "available",
			skillKind: "skill_pack",
			effectiveInstructions: "BASE_V1: Use only selected sources.",
			durationPolicy: "next_message",
			sourceIds: {
				packSkillId: pack.id,
				packSkillVersion: 1,
				variantSkillId: null,
				variantSkillVersion: null,
			},
			publicSummary: expect.not.objectContaining({
				instructions: expect.any(String),
			}),
		});

		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: standalone.id,
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: true,
			skillKind: "user_skill",
			effectiveInstructions: "USER_ONLY: Coach privately.",
			durationPolicy: "session",
			notesPolicy: "create_private_notes",
			sourceIds: {
				skillId: standalone.id,
				skillVersion: 1,
				packSkillId: null,
				variantSkillId: null,
			},
		});

		const variantV1 = await resolveEffectiveSkillDefinition("user-1", {
			id: "variant-1",
			ownership: "user",
		});
		expect(variantV1).toMatchObject({
			available: true,
			skillKind: "skill_variant",
			effectiveInstructions:
				"BASE_V1: Use only selected sources.\n\nOVERLAY_V1: Use a terse executive voice.",
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			sourceIds: {
				packSkillId: pack.id,
				packSkillVersion: 1,
				variantSkillId: "variant-1",
				variantSkillVersion: 1,
			},
			publicSummary: expect.objectContaining({
				id: "variant-1",
				skillKind: "skill_variant",
				baseSkillId: pack.id,
				baseSkillDisplayName: "Research Pack",
			}),
		});
		expect(JSON.stringify(variantV1.publicSummary)).not.toContain("BASE_V1");
		expect(JSON.stringify(variantV1.publicSummary)).not.toContain("OVERLAY_V1");
		expect(variantV1.effectiveInstructionsHash).toMatch(/^[a-f0-9]{64}$/);

		await updateSystemSkillDefinition(pack.id, {
			instructions: "BASE_V2: Updated pack base.",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: "variant-1",
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: true,
			effectiveInstructions:
				"BASE_V2: Updated pack base.\n\nOVERLAY_V1: Use a terse executive voice.",
			sourceIds: {
				packSkillId: pack.id,
				packSkillVersion: 2,
				variantSkillId: "variant-1",
				variantSkillVersion: 1,
			},
		});
	});

	it("reports effective resolver unavailability without leaking cross-user or pack instructions", async () => {
		seedUsers();
		const {
			createSystemSkillDefinition,
			resolveEffectiveSkillDefinition,
			updateSystemSkillDefinition,
		} = await import("./user-skills");
		const { db } = await import("$lib/server/db");

		const disabledPack = await createSystemSkillDefinition("user-1", {
			displayName: "Disabled Pack",
			instructions: "DISABLED_PACK_SECRET",
			published: true,
			enabled: false,
		});
		const unpublishedPack = await createSystemSkillDefinition("user-1", {
			displayName: "Unpublished Pack",
			instructions: "UNPUBLISHED_PACK_SECRET",
			published: true,
		});
		await updateSystemSkillDefinition(unpublishedPack.id, { published: false });
		const insertVariant = (
			id: string,
			userId: string,
			baseSkillId: string | null,
			enabled = true,
		) =>
			db
				.insert(schema.userSkillDefinitions)
				.values({
					id,
					userId,
					ownership: "user",
					skillKind: "skill_variant",
					baseSkillId,
					displayName: `${id} variant`,
					description: "Variant overlay.",
					instructions: `${id.toUpperCase()}_OVERLAY_SECRET`,
					activationExamplesJson: "[]",
					enabled,
					published: false,
					durationPolicy: "next_message",
					questionPolicy: "none",
					notesPolicy: "none",
					sourceScope: "current_conversation",
					creationSource: "user_created",
				})
				.run();
		insertVariant("variant-disabled-pack", "user-1", disabledPack.id);
		insertVariant("variant-unpublished-pack", "user-1", unpublishedPack.id);
		insertVariant("variant-missing-pack", "user-1", "system:missing-pack");
		insertVariant("variant-disabled", "user-1", disabledPack.id, false);
		insertVariant("variant-other-user", "user-2", disabledPack.id);

		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: disabledPack.id,
				ownership: "system",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "disabled",
			effectiveInstructions: "",
			effectiveInstructionsHash: null,
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: unpublishedPack.id,
				ownership: "system",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "unpublished",
			effectiveInstructions: "",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: "variant-disabled-pack",
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "base_pack_disabled",
			effectiveInstructions: "",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: "variant-unpublished-pack",
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "base_pack_unpublished",
			effectiveInstructions: "",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: "variant-missing-pack",
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "base_pack_missing",
			effectiveInstructions: "",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: "variant-disabled",
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "disabled",
			effectiveInstructions: "",
		});
		await expect(
			resolveEffectiveSkillDefinition("user-1", {
				id: "variant-other-user",
				ownership: "user",
			}),
		).resolves.toMatchObject({
			available: false,
			availabilityReason: "not_found",
			displayName: null,
			publicSummary: null,
		});

		const serializedResults = JSON.stringify([
			await resolveEffectiveSkillDefinition("user-1", {
				id: disabledPack.id,
				ownership: "system",
			}),
			await resolveEffectiveSkillDefinition("user-1", {
				id: "variant-disabled-pack",
				ownership: "user",
			}),
			await resolveEffectiveSkillDefinition("user-1", {
				id: "variant-other-user",
				ownership: "user",
			}),
		]);
		expect(serializedResults).not.toContain("DISABLED_PACK_SECRET");
		expect(serializedResults).not.toContain(
			"VARIANT-DISABLED-PACK_OVERLAY_SECRET",
		);
		expect(serializedResults).not.toContain(
			"VARIANT-OTHER-USER_OVERLAY_SECRET",
		);
	});

	it("strengthens grill-with-docs, document-explainer, purchase-helper, and appointment-prep instructions with severity, confidence, comparison, and verify/flag guidance", async () => {
		seedUsers();
		const { getBuiltInSystemSkillEnInstructions } = await import(
			"./user-skills"
		);

		expect(
			getBuiltInSystemSkillEnInstructions("system:grill-with-docs"),
		).toContain("Blocker");
		expect(
			getBuiltInSystemSkillEnInstructions("system:document-explainer"),
		).toContain("Confidence: high/medium/low");
		expect(
			getBuiltInSystemSkillEnInstructions("system:purchase-helper"),
		).toContain("comparison table");
		expect(
			getBuiltInSystemSkillEnInstructions("system:appointment-prep"),
		).toContain("verify / flag");
	});

	it("enriches the spreadsheet finance-models managed resource with scenario and breakeven guidance", async () => {
		seedUsers();
		const { getSpreadsheetFinanceModelsResourceContent } = await import(
			"./user-skills"
		);

		const content = getSpreadsheetFinanceModelsResourceContent();
		expect(content).toContain("below breakeven");
		expect(content).toContain("scenario");
		expect(content).toContain("what would change this conclusion");
		expect(content.length).toBeLessThanOrEqual(700);
		expect(content.slice(0, 650)).toContain("scenario");
		expect(content.slice(0, 650)).toContain("below breakeven");
		expect(content.slice(0, 650)).toContain(
			"what would change this conclusion",
		);
	});

	it("registers pre-edit English instructions as previous defaults for the four strengthened packs", async () => {
		seedUsers();
		const { previousDefaultsForBuiltInSkill } = await import("./user-skills");

		const grillPreEdit = [
			"Run a focused plan-critique workflow. Your job is to improve correctness before execution, not to rubber-stamp the plan.",
			"Use the current user message, conversation context, and selected linked sources. Do not claim to have read documents or code that were not provided in context.",
			"When source material is available, separate source-backed findings from reasoned concerns. Quote or reference source facts only when they are actually present.",
			"Check for contradictions, weak assumptions, missing decisions, overloaded terminology, unverified dependencies, scope creep, and cases where the plan conflicts with product language or prior decisions.",
			"If a question is needed, ask one focused question and include your recommended answer. If the answer can be discovered from available context, discover it instead of asking.",
			"Prefer concrete revisions: changed wording, added acceptance criteria, removed scope, renamed terms, or an explicit decision that should be recorded.",
			"Output with the highest-impact issues first. Keep summaries brief and make the next action obvious.",
		].join("\n");
		expect(
			previousDefaultsForBuiltInSkill("system:grill-with-docs").some(
				(d) => d.instructions === grillPreEdit,
			),
		).toBe(true);

		const documentExplainerPreEdit = [
			"Explain the selected or attached document so the user can act on it.",
			"Start with the main point in plain language, then unpack the important terms, obligations, decisions, numbers, and caveats.",
			"Ground claims in the provided document. If the user asks for something the document does not answer, say that clearly and separate inference from source fact.",
			"Preserve important concrete details such as dates, thresholds, names, requirements, and exceptions. Do not flatten them into vague summaries.",
			"Adapt depth to the user's apparent familiarity. For beginners, define terms before using them; for advanced users, focus on implications and edge cases.",
			"When useful, end with a short list of decisions, risks, or follow-up questions the document implies.",
		].join("\n");
		expect(
			previousDefaultsForBuiltInSkill("system:document-explainer").some(
				(d) => d.instructions === documentExplainerPreEdit,
			),
		).toBe(true);

		const purchaseHelperPreEdit = [
			"Help the user make a purchase decision that fits their actual constraints, not a generic best-product ranking.",
			"First identify the decision criteria: budget, location, timeline, must-haves, nice-to-haves, dealbreakers, ownership costs, compatibility, warranty, support, and risk tolerance.",
			"Compare options by practical tradeoffs. Include why an option may be wrong for this user even if it is objectively strong.",
			"Treat prices, availability, laws, insurance terms, and product specifications as freshness-sensitive. Use available current sources when possible; otherwise label uncertainty clearly.",
			"Preserve concrete user facts from the conversation, such as owned items, existing subscriptions, region, compatibility requirements, and prior preferences.",
			"End with a recommendation only when the evidence supports it. Otherwise provide a shortlist, decision matrix, or the one missing fact that would decide it.",
		].join("\n");
		expect(
			previousDefaultsForBuiltInSkill("system:purchase-helper").some(
				(d) => d.instructions === purchaseHelperPreEdit,
			),
		).toBe(true);

		const appointmentPrepPreEdit = [
			"Prepare the user for an appointment, meeting, call, or administrative interaction.",
			"Identify the goal, counterpart, timing, constraints, prior context, required documents, decisions needed, and what a good outcome looks like.",
			"Organize the preparation into agenda, context to mention, questions to ask, materials to bring or send, risks or sensitive points, and follow-up actions.",
			"Preserve concrete facts from the conversation and selected sources. Do not invent appointment details, eligibility rules, deadlines, or legal/medical/financial advice.",
			"If the situation is high-stakes or current-rule-dependent, flag what should be verified with an official source or professional.",
			"Keep the output usable during the appointment: concise phrasing, prioritized questions, and a short checklist.",
		].join("\n");
		expect(
			previousDefaultsForBuiltInSkill("system:appointment-prep").some(
				(d) => d.instructions === appointmentPrepPreEdit,
			),
		).toBe(true);
	});

	it("upgrades a seeded row holding pre-edit grill-with-docs instructions but leaves admin-edited text untouched", async () => {
		seedUsers();
		const sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		const legacyDb = drizzle(sqlite, { schema });
		const grillPreEditV2 = [
			"Run a focused plan-critique workflow. Your job is to improve correctness before execution, not to rubber-stamp the plan.",
			"Use the current user message, conversation context, and selected linked sources. Do not claim to have read documents or code that were not provided in context.",
			"When source material is available, separate source-backed findings from reasoned concerns. Quote or reference source facts only when they are actually present.",
			"Check for contradictions, weak assumptions, missing decisions, overloaded terminology, unverified dependencies, scope creep, and cases where the plan conflicts with product language or prior decisions.",
			"If a question is needed, ask one focused question and include your recommended answer. If the answer can be discovered from available context, discover it instead of asking.",
			"Prefer concrete revisions: changed wording, added acceptance criteria, removed scope, renamed terms, or an explicit decision that should be recorded.",
			"Output with the highest-impact issues first. Keep summaries brief and make the next action obvious.",
		].join("\n");
		legacyDb
			.insert(schema.userSkillDefinitions)
			.values([
				{
					id: "system:grill-with-docs",
					userId: "user-1",
					ownership: "system",
					displayName: "Plan Critic",
					description:
						"Stress-tests plans against selected sources, product language, constraints, and implementation reality.",
					instructions: grillPreEditV2,
					activationExamplesJson: JSON.stringify([
						"criticize this plan",
						"challenge this against our ADRs",
						"stress-test this implementation plan",
						"find the weak assumptions",
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
					id: "system:purchase-helper",
					userId: "user-1",
					ownership: "system",
					displayName: "Purchase Helper",
					description:
						"Compares buying options against user needs, constraints, tradeoffs, risks, and current evidence.",
					instructions: "Admin-edited purchase helper instructions.",
					activationExamplesJson: JSON.stringify([
						"help me choose what to buy",
						"compare these options",
						"which option fits my needs",
						"make a buying decision matrix",
					]),
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

		const { getSystemSkillDefinition, seedBuiltInSystemSkillDefinitions } =
			await import("./user-skills");

		await seedBuiltInSystemSkillDefinitions("user-1");

		const upgradedGrill = await getSystemSkillDefinition(
			"system:grill-with-docs",
		);
		expect(upgradedGrill?.instructions).toContain("Blocker");
		expect(upgradedGrill?.instructions).not.toBe(grillPreEditV2);

		const untouchedPurchaseHelper = await getSystemSkillDefinition(
			"system:purchase-helper",
		);
		expect(untouchedPurchaseHelper?.instructions).toBe(
			"Admin-edited purchase helper instructions.",
		);
	});

	it("leaves translate-rewrite and study-coach instructions unchanged", async () => {
		seedUsers();
		const { getBuiltInSystemSkillEnInstructions } = await import(
			"./user-skills"
		);

		expect(
			getBuiltInSystemSkillEnInstructions("system:translate-rewrite"),
		).toBe(
			[
				"Transform the user's text while preserving meaning, intent, facts, and audience fit.",
				"Before changing ambiguous meaning, ask a focused question or provide the safest version with a brief note about the ambiguity.",
				"Keep terminology, names, dates, numbers, and formatting-sensitive details consistent unless the user asks to change them.",
				"For translation, prefer natural target-language phrasing over word-for-word literalism, while preserving register and nuance.",
				"For rewriting, match the requested tone and medium. Remove clutter, improve structure, and keep the user's voice where possible.",
				"Usually provide the revised text first. Add a short explanation only when changes are material or the user asked for reasoning.",
			].join("\n"),
		);

		expect(getBuiltInSystemSkillEnInstructions("system:study-coach")).toBe(
			[
				"Coach the user through active learning rather than only summarizing material.",
				"Break the topic into learnable chunks, identify prerequisites, and explain the first chunk before moving deeper.",
				"Use retrieval practice: ask one short check-for-understanding question when useful, then adapt based on the user's answer.",
				"Correct misunderstandings directly and kindly. Explain why the correction matters, not just what the right answer is.",
				"Use examples, contrasts, and small exercises. Prefer concrete practice over abstract encouragement.",
				"End with practical next study steps, spaced repetition prompts, or a small self-test when appropriate.",
			].join("\n"),
		);
	});
});
