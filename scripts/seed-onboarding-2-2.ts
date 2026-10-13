#!/usr/bin/env tsx
// Adds what the AlfyAI 2.2 first-run onboarding's pictures need to the scratch database that
// `scripts/seed-campaign-2-2.ts` already filled (the release campaign's sample: Anna Kovács, her
// Balaton project, her chats, her Document, board and App):
//
//   * a second user, Bence Szabó, who has just signed up: no chats, no projects, no files, not an
//     administrator. The welcome is what a person like him sees first, and the home page and the
//     Settings page he sees are the pictures of the slides that are about those places;
//   * Anna's Memory profile: a handful of facts the way the memory judge writes them, and the
//     portrait paragraph, written through the app's own projection store;
//   * a pinned chat for Anna, so the sidebar picture shows every section the sidebar has, and in it a
//     second Document (a weekly menu) with a history of its own: Alfy's first draft, Anna's edit
//     (named), a change of Alfy's that she kept and one that waits for her, so the History picture
//     is not the trip plan the release campaign already shows;
//   * both users' e-mail addresses on `example.com` (the reserved documentation domain), because
//     the sidebar shows the address under the name and `campaign.local` reads as leftover test data;
//   * a model with a name of its own ("Alfy 1") instead of the placeholder an empty database is
//     seeded with, and the id the server needs as its default (`defaultModel` in the manifest:
//     start the server with `DEFAULT_NEW_USER_MODEL` set to it, so the Settings page and the setup
//     slide name the default model instead of printing its internal id).
//
// Everything is invented sample content in Hungarian: no real person, address or file.
//
// Run it ONCE, after the release sample, on the same scratch database, with the server stopped:
//   rm -f data/onboarding-2-2.db data/onboarding-2-2.db-shm data/onboarding-2-2.db-wal
//   export DATABASE_PATH=$PWD/data/onboarding-2-2.db
//   npm run db:prepare && npx tsx scripts/seed-campaign-2-2.ts && npx tsx scripts/seed-onboarding-2-2.ts
// It reads `<database dir>/campaign-2-2-manifest.json` and writes
// `<database dir>/campaign-onboarding-manifest.json` (the sign-ins and ids) for
// `scripts/campaign-shots-onboarding-2-2.ts`.

import { config as dotenvConfig } from "dotenv";

dotenvConfig();
if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET =
		"campaign-seed-session-secret-12345678901234567890";
}
if (!process.env.DATABASE_PATH)
	process.env.DATABASE_PATH = "./data/onboarding-2-2.db";

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The user the welcome is about: signed up a minute ago, so the workspace is empty. */
export const NEW_USER = {
	email: "bence.szabo@example.com",
	password: "Welcome-2-2-demo",
	name: "Bence Szabó",
} as const;

/** The populated user of the release sample, with an address that reads as one. */
export const SAMPLE_USER_EMAIL = "anna.kovacs@example.com";

const PORTRAIT =
	"Budapesten élsz, két gyerek, egy 6 és egy 9 éves édesanyja vagy. A családdal három napra a Balatonra készültök, 450 000 forintos kerettel, és közben a lakásfelújításon is dolgozol. Magyarul, tegezve és röviden szeretsz beszélgetni, az árakat forintban kéred.";

const FACTS: {
	category:
		| "about_you"
		| "preferences"
		| "goals_ongoing_work"
		| "constraints_boundaries";
	key: string;
	statement: string;
}[] = [
	{
		category: "about_you",
		key: "gyerekek",
		statement: "Két gyerekem van, 6 és 9 évesek.",
	},
	{
		category: "about_you",
		key: "lakohely",
		statement: "Budapesten élek.",
	},
	{
		category: "preferences",
		key: "nyelv",
		statement: "Magyarul szeretek beszélgetni, tegezve.",
	},
	{
		category: "preferences",
		key: "stilus",
		statement:
			"Rövid, lényegre törő válaszokat szeretek, felsorolások helyett összefüggő mondatokat.",
	},
	{
		category: "preferences",
		key: "penznem",
		statement: "Az árakat mindig forintban kérem.",
	},
	{
		category: "goals_ongoing_work",
		key: "balaton",
		statement:
			"A családdal három napra a Balatonra készülünk, a keret 450 000 forint.",
	},
	{
		category: "goals_ongoing_work",
		key: "felujitas",
		statement: "Felújítom a lakást, a nappali festésével kezdem.",
	},
	{
		category: "constraints_boundaries",
		key: "foglalas",
		statement: "Nem foglalok olyan szállást, amelyet nem lehet módosítani.",
	},
];

const MENU_V1 = [
	"# Heti menü",
	"",
	"Négy főre, gyerekbarát vacsorákkal.",
	"",
	"## Vacsorák",
	"",
	"- Hétfő: sajtos tészta, saláta",
	"- Kedd: csirkemell zöldségekkel, rizs",
	"- Szerda: lecsó kolbásszal",
	"- Csütörtök: húsleves, palacsinta",
	"- Péntek: sült krumpli, tükörtojás",
	"",
	"## Bevásárlólista",
	"",
	"- tészta, reszelt sajt, saláta",
	"- csirkemell, rizs, zöldségek",
	"- paprika, paradicsom, kolbász",
	"- csontos hús és zöldség a levesbe, tojás, liszt",
	"- krumpli, olaj",
].join("\n");

/** The story is told in a fixed-offset zone (the release sample's), so History groups by the days drawn here. */
function zoneOffsetMinutes(zone: string, at: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return Math.round((asUtc - at.getTime()) / 60000);
}

/** `daysAgo` days back from today (in `zone`), at HH:MM on that zone's clock. */
function wall(zone: string, daysAgo: number, hhmm: string): Date {
	const [hour, minute] = hhmm.split(":").map(Number);
	const now = new Date();
	const local = new Date(now.getTime() + zoneOffsetMinutes(zone, now) * 60000);
	const utcMidnight = Date.UTC(
		local.getUTCFullYear(),
		local.getUTCMonth(),
		local.getUTCDate() - daysAgo,
		hour,
		minute,
	);
	const guess = new Date(utcMidnight);
	return new Date(utcMidnight - zoneOffsetMinutes(zone, guess) * 60000);
}

async function main(): Promise<void> {
	const databasePath = resolve(
		process.env.DATABASE_PATH ?? "./data/onboarding-2-2.db",
	);
	const releaseManifestPath = join(
		dirname(databasePath),
		"campaign-2-2-manifest.json",
	);
	const release = JSON.parse(readFileSync(releaseManifestPath, "utf8")) as {
		timeZone: string;
		user: { email: string; password: string; id: string };
		project: { id: string };
		conversations: Record<string, string>;
		artifacts: Record<string, string>;
	};

	const bcrypt = (await import("bcryptjs")).default;
	const { and, eq } = await import("drizzle-orm");
	const { db } = await import("$lib/server/db/index");
	const schema = await import("$lib/server/db/schema");
	const {
		createMemoryProfileItem,
		ensureProjectionState,
		storePersonaSummaryProjection,
	} = await import("$lib/server/services/memory-profile/projection-store");
	const { setConversationSidebarPinned } = await import(
		"$lib/server/services/conversations"
	);

	const already = db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(eq(schema.users.email, NEW_USER.email))
		.get();
	if (already) {
		throw new Error(
			`${NEW_USER.email} already exists in ${databasePath}. Start from a fresh database file (see the header).`,
		);
	}
	const anna = db
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(eq(schema.users.id, release.user.id))
		.get();
	if (!anna) {
		throw new Error(
			`The release sample's user is not in ${databasePath}: run scripts/seed-campaign-2-2.ts first.`,
		);
	}

	// -- addresses on example.com ----------------------------------------------
	db.update(schema.users)
		.set({ email: SAMPLE_USER_EMAIL })
		.where(eq(schema.users.id, anna.id))
		.run();

	// -- a model with a name -------------------------------------------------------
	const provider = db
		.select({ id: schema.providers.id })
		.from(schema.providers)
		.get();
	const model = db
		.select({ id: schema.providerModels.id })
		.from(schema.providerModels)
		.get();
	if (!provider || !model) {
		throw new Error(
			"The database has no provider and model (npm run db:prepare).",
		);
	}
	db.update(schema.providers)
		.set({ displayName: "Alfy" })
		.where(eq(schema.providers.id, provider.id))
		.run();
	db.update(schema.providerModels)
		.set({ displayName: "Alfy 1" })
		.where(eq(schema.providerModels.id, model.id))
		.run();

	// -- the new user ------------------------------------------------------------
	const bence = randomUUID();
	db.insert(schema.users)
		.values({
			id: bence,
			email: NEW_USER.email,
			passwordHash: bcrypt.hashSync(NEW_USER.password, 10),
			name: NEW_USER.name,
			role: "user",
			uiLanguage: "hu",
			theme: "light",
		})
		.run();

	// -- Anna's Memory profile, through the projection store -----------------------
	const projection = await ensureProjectionState({
		userId: anna.id,
		resetGeneration: 0,
	});
	for (const fact of FACTS) {
		await createMemoryProfileItem({
			userId: anna.id,
			category: fact.category,
			scope: { type: "global" },
			statement: fact.statement,
			itemKey: `onboarding-${fact.key}`,
		});
	}
	await storePersonaSummaryProjection({
		projectionStateId: projection.id,
		personaSummaryText: PORTRAIT,
		personaSummaryLinksJson: "[]",
		now: new Date(),
	});

	// -- a pinned chat, so every section of the sidebar is drawn --------------------
	// One outside the projects, so that pinning it does not empty a project's row.
	const menuChat = db
		.select({ id: schema.conversations.id })
		.from(schema.conversations)
		.where(
			and(
				eq(schema.conversations.userId, anna.id),
				eq(schema.conversations.title, "Heti menü és bevásárlólista"),
			),
		)
		.get();
	if (!menuChat)
		throw new Error("The weekly menu chat is not in the release sample.");
	await setConversationSidebarPinned(anna.id, menuChat.id, true);

	// -- a Document with a history, in the weekly-menu chat -------------------------
	const artifactsFacade = await import("$lib/server/services/artifacts");
	const { VERSION_SUMMARY } = await import(
		"$lib/shared/artifacts/version-summaries"
	);
	const at = (daysAgo: number, hhmm: string) =>
		wall(release.timeZone, daysAgo, hhmm);
	const versionIdOf = (artifactId: string, versionNumber: number) => {
		const row = db
			.select({ id: schema.artifactVersions.id })
			.from(schema.artifactVersions)
			.where(
				and(
					eq(schema.artifactVersions.artifactId, artifactId),
					eq(schema.artifactVersions.versionNumber, versionNumber),
				),
			)
			.get();
		if (!row) throw new Error(`No version ${versionNumber} on ${artifactId}`);
		return row.id;
	};
	const setVersionTime = (
		artifactId: string,
		versionNumber: number,
		when: Date,
	) => {
		db.update(schema.artifactVersions)
			.set({ createdAt: when, startedAt: when })
			.where(
				eq(schema.artifactVersions.id, versionIdOf(artifactId, versionNumber)),
			)
			.run();
	};
	const lastSequence = (conversationId: string) =>
		db
			.select({ n: schema.messages.messageSequence })
			.from(schema.messages)
			.where(eq(schema.messages.conversationId, conversationId))
			.all()
			.reduce((max, row) => Math.max(max, row.n ?? 0), 0);
	const must = <T>(value: T | null | undefined, what: string): T => {
		if (value === null || value === undefined) {
			throw new Error(`Seed step failed: ${what}`);
		}
		return value;
	};

	const menu = await artifactsFacade.createDocumentArtifact({
		userId: anna.id,
		conversationId: menuChat.id,
		title: "Heti menü",
		markdown: MENU_V1,
		author: "alfy",
		summary: VERSION_SUMMARY.alfyFirstDraft,
	});
	setVersionTime(menu.id, 1, at(1, "18:14"));
	db.update(schema.artifacts)
		.set({ createdAt: at(1, "18:14"), updatedAt: at(1, "18:14") })
		.where(eq(schema.artifacts.id, menu.id))
		.run();
	// The chat says so: a second turn, with the card the Document makes in the reply.
	const firstSequence = lastSequence(menuChat.id) + 1;
	db.insert(schema.messages)
		.values({
			id: randomUUID(),
			conversationId: menuChat.id,
			messageSequence: firstSequence,
			role: "user",
			content: "Tedd ezt dokumentumba, és írj mellé bevásárlólistát is.",
			createdAt: at(1, "18:12"),
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: randomUUID(),
			conversationId: menuChat.id,
			messageSequence: firstSequence + 1,
			role: "assistant",
			content:
				"Kész: a menüt és a hozzá tartozó bevásárlólistát egy dokumentumba tettem.",
			toolCalls: JSON.stringify([
				{
					type: "tool_call",
					callId: "seed-menu",
					name: "create_artifact",
					input: {
						artifactType: "document",
						title: "Heti menü",
						body: MENU_V1,
					},
					status: "done",
					outputSummary: 'Created document "Heti menü"',
					sourceType: "tool",
					metadata: {
						ok: true,
						artifactId: menu.id,
						artifactKind: "document",
						artifactTitle: "Heti menü",
					},
				},
			]),
			createdAt: at(1, "18:14"),
		})
		.run();
	db.update(schema.conversations)
		.set({ updatedAt: at(0, "12:40") })
		.where(eq(schema.conversations.id, menuChat.id))
		.run();

	// Anna's own edit, saved the way the editor saves, and named.
	const menuDetail = must(
		await artifactsFacade.getArtifact({
			userId: anna.id,
			artifactId: menu.id,
			conversationId: menuChat.id,
		}),
		"the menu",
	);
	const edited = must(menuDetail.body, "the menu's body").replace(
		"Szerda: lecsó kolbásszal",
		"Szerda: tökfőzelék fasírttal",
	);
	const saved = await artifactsFacade.saveDocumentBody({
		userId: anna.id,
		artifactId: menu.id,
		conversationId: menuChat.id,
		body: {
			markdown: edited,
			tabs: artifactsFacade.documentTabsFromMetadata(menuDetail.metadata),
		},
		author: "user",
		summary: VERSION_SUMMARY.edited,
	});
	if (!saved.ok) throw new Error(`Anna's edit was refused: ${saved.reason}`);
	setVersionTime(menu.id, 2, at(1, "19:02"));
	const afterEdit = await artifactsFacade.listVersions({
		userId: anna.id,
		artifactId: menu.id,
		conversationId: menuChat.id,
	});
	await artifactsFacade.nameVersion({
		userId: anna.id,
		artifactId: menu.id,
		conversationId: menuChat.id,
		versionId: must(
			afterEdit.find((version) => version.versionNumber === 2),
			"Anna's version",
		).id,
		label: "Mielőtt bevásárolok",
	});

	// Alfy rewrites the shopping list for Wednesday's new dish, and Anna keeps the change.
	const patchOnce = async (find: string, text: string, label: string) => {
		const read = await artifactsFacade.readDocumentForAlfy({
			userId: anna.id,
			artifactId: menu.id,
			conversationId: menuChat.id,
		});
		const block = must(
			read.blocks.find((candidate) => candidate.text.includes(find)),
			`the block with "${find}"`,
		);
		const result = await artifactsFacade.applyDocumentPatch({
			userId: anna.id,
			artifactId: menu.id,
			conversationId: menuChat.id,
			patch: {
				patchId: randomUUID(),
				label,
				ops: [
					{
						opId: randomUUID(),
						kind: "replaceRange",
						blockId: block.blockId,
						baseHash: block.hash,
						blockLabel: block.label,
						find,
						text,
					},
				],
			},
		});
		if (!result.ok || result.result.applied !== 1) {
			throw new Error(`Alfy's change was refused: ${JSON.stringify(result)}`);
		}
	};
	await patchOnce(
		"paprika, paradicsom, kolbász",
		"tök, darált hús, tej, liszt",
		"Átírta a bevásárlólistát a szerdai étlaphoz",
	);
	setVersionTime(menu.id, 3, at(0, "09:05"));
	const pending = await artifactsFacade.getDocumentReviewState({
		userId: anna.id,
		artifactId: menu.id,
		conversationId: menuChat.id,
	});
	if (!pending.ok)
		throw new Error("The menu's review state could not be read.");
	await artifactsFacade.acknowledgeDocumentReviewBlocks({
		userId: anna.id,
		artifactId: menu.id,
		conversationId: menuChat.id,
		blockIds: pending.pending.map((block) => block.blockId),
	});

	// And one more that waits for her: a vegetable beside Friday's eggs.
	await patchOnce(
		"sült krumpli, tükörtojás",
		"sült krumpli, tükörtojás, uborkasaláta",
		"Zöldséget tett a pénteki vacsorához",
	);
	setVersionTime(menu.id, 4, at(0, "12:40"));
	db.update(schema.artifacts)
		.set({ updatedAt: at(0, "12:40") })
		.where(eq(schema.artifacts.id, menu.id))
		.run();

	const manifest = {
		timeZone: release.timeZone,
		anna: {
			email: SAMPLE_USER_EMAIL,
			password: release.user.password,
			id: anna.id,
		},
		bence: { email: NEW_USER.email, password: NEW_USER.password, id: bence },
		defaultModel: `provider:${provider.id}:${model.id}`,
		project: release.project,
		conversations: release.conversations,
		artifacts: { ...release.artifacts, menu: menu.id },
		conversationsMore: { menu: menuChat.id },
	};
	const manifestPath = join(
		dirname(databasePath),
		"campaign-onboarding-manifest.json",
	);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(
		`Seeded ${NEW_USER.email} and the memory profile. Manifest: ${manifestPath}`,
	);
}

await main();
