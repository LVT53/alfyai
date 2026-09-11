import { describe, expect, it } from "vitest";
import {
	buildAtlasSeeds,
	buildConnectionSeeds,
	buildConversationSeeds,
	buildMemorySeeds,
	fillTemplate,
	type HomeSuggestionSeed,
	rankHomeSuggestionSeeds,
	renderHomeSuggestion,
	shortenObject,
} from "./home-suggestions";

function connection(
	overrides: Partial<Parameters<typeof buildConnectionSeeds>[0][number]> = {},
) {
	return {
		id: "conn-1",
		label: "Nextcloud",
		displayName: "Nextcloud",
		status: "connected",
		grantedCapabilities: ["files"],
		capabilities: ["files"],
		updatedAt: 1_000,
		lastUsedAt: null,
		...overrides,
	};
}

function seed(overrides: Partial<HomeSuggestionSeed> = {}): HomeSuggestionSeed {
	return {
		key: "calendar:a",
		kind: "calendar",
		icon: "calendar",
		textKey: "home.suggest.calendar",
		labelKey: "home.suggest.calendar.short",
		params: {},
		source: "Google",
		objectUpdatedAt: 100,
		...overrides,
	};
}

describe("fillTemplate", () => {
	it("substitutes every occurrence of a placeholder", () => {
		expect(fillTemplate("{a} and {a} and {b}", { a: "x", b: "y" })).toBe(
			"x and x and y",
		);
	});

	it("leaves an unsupplied placeholder standing rather than blanking it", () => {
		expect(fillTemplate("Summarise the last {provider} upload", {})).toBe(
			"Summarise the last {provider} upload",
		);
	});

	it("passes a template with no placeholders through unchanged", () => {
		expect(fillTemplate("Check what needs a reply", { name: "Kata" })).toBe(
			"Check what needs a reply",
		);
	});
});

describe("shortenObject", () => {
	it("leaves a short object alone", () => {
		expect(shortenObject("EU battery rules")).toBe("EU battery rules");
	});

	it("collapses whitespace", () => {
		expect(shortenObject("EU   battery\nrules")).toBe("EU battery rules");
	});

	it("cuts on a word boundary and marks the cut", () => {
		const short = shortenObject(
			"Hungarian EV charging subsidies, 2024-2026",
			28,
		);
		expect(short).toBe("Hungarian EV charging…");
		expect(short.length).toBeLessThanOrEqual(29);
	});

	it("cuts mid-word rather than losing most of a long first word", () => {
		expect(
			shortenObject("Donaudampfschifffahrtsgesellschaftskapitaen", 10),
		).toBe("Donaudampf…");
	});
});

describe("buildConnectionSeeds — templates filled with the real object", () => {
	it("offers the calendar opener for a granted, enabled calendar", () => {
		const seeds = buildConnectionSeeds([
			connection({
				id: "g1",
				label: "Google Calendar",
				displayName: "Google",
				grantedCapabilities: ["calendar", "contacts"],
				capabilities: ["calendar", "contacts"],
			}),
		]);
		expect(seeds).toHaveLength(1);
		expect(seeds[0]).toMatchObject({
			key: "calendar:g1",
			kind: "calendar",
			textKey: "home.suggest.calendar",
			source: "Google Calendar",
		});
	});

	it("names the provider in the files template", () => {
		const [files] = buildConnectionSeeds([connection({ id: "n1" })]);
		expect(files?.textKey).toBe("home.suggest.files");
		expect(files?.params).toEqual({ provider: "Nextcloud" });
		expect(
			renderHomeSuggestion(
				{ ...(files as HomeSuggestionSeed), actedOn: false },
				"en",
			).text,
		).toBe("Summarise the last Nextcloud upload");
	});

	it("uses the named-file template only when a file is actually known", () => {
		const generic = buildConnectionSeeds([connection()])[0];
		expect(generic?.textKey).toBe("home.suggest.files");

		const named = buildConnectionSeeds([connection()], {
			recentFileName: "Q3 forecast.xlsx",
		})[0];
		expect(named?.textKey).toBe("home.suggest.fileNamed");
		expect(named?.params).toEqual({
			provider: "Nextcloud",
			file: "Q3 forecast.xlsx",
		});
	});

	it("falls back to the generic email form when no owed reply is known", () => {
		const [email] = buildConnectionSeeds([
			connection({
				id: "m1",
				label: "Email",
				displayName: "Email",
				grantedCapabilities: ["email"],
				capabilities: ["email"],
			}),
		]);
		expect(email?.textKey).toBe("home.suggest.emailGeneric");
		expect(
			renderHomeSuggestion(
				{ ...(email as HomeSuggestionSeed), actedOn: false },
				"en",
			).text,
		).toBe("Check what needs a reply");
	});

	it("names the person when one can be identified", () => {
		const [email] = buildConnectionSeeds(
			[
				connection({
					id: "m1",
					grantedCapabilities: ["email"],
					capabilities: ["email"],
				}),
			],
			{ owedReplyTo: "Kata" },
		);
		expect(email?.textKey).toBe("home.suggest.emailPerson");
		expect(
			renderHomeSuggestion(
				{ ...(email as HomeSuggestionSeed), actedOn: false },
				"en",
			).text,
		).toBe("Draft the reply you owe Kata");
	});

	it("ignores a capability the provider granted but the user switched off", () => {
		expect(
			buildConnectionSeeds([
				connection({ grantedCapabilities: ["files"], capabilities: [] }),
			]),
		).toEqual([]);
	});

	it("ignores a capability the user enabled but the provider never granted", () => {
		expect(
			buildConnectionSeeds([
				connection({ grantedCapabilities: [], capabilities: ["files"] }),
			]),
		).toEqual([]);
	});

	it("ignores a connection that is not connected", () => {
		expect(
			buildConnectionSeeds([connection({ status: "needs_reauth" })]),
		).toEqual([]);
	});

	it("ranks a connection by its last use, not just its row update", () => {
		const [files] = buildConnectionSeeds([
			connection({ updatedAt: 100, lastUsedAt: 900 }),
		]);
		expect(files?.objectUpdatedAt).toBe(900);
	});
});

describe("buildMemorySeeds / buildConversationSeeds / buildAtlasSeeds", () => {
	it("fills the memory template with the goal statement", () => {
		const [goal] = buildMemorySeeds(
			[
				{
					id: "m1",
					statement: "Cleaning up the Nextcloud share",
					updatedAt: 500,
				},
			],
			"Memory · ongoing work",
		);
		expect(
			renderHomeSuggestion(
				{ ...(goal as HomeSuggestionSeed), actedOn: false },
				"en",
			).text,
		).toBe("Finish Cleaning up the Nextcloud share");
		expect(goal?.source).toBe("Memory · ongoing work");
		expect(goal?.key).toBe("memory:m1");
	});

	it("drops an empty memory statement", () => {
		expect(
			buildMemorySeeds([{ id: "m1", statement: "   ", updatedAt: 1 }], "x"),
		).toEqual([]);
	});

	it("fills the conversation template with the conversation's own title", () => {
		const [topic] = buildConversationSeeds(
			[{ id: "c1", title: "the September invoice", updatedAt: 400 }],
			"A recent conversation",
		);
		const rendered = renderHomeSuggestion(
			{ ...(topic as HomeSuggestionSeed), actedOn: false },
			"en",
		);
		expect(rendered.text).toBe("Ask about the September invoice");
		expect(rendered.label).toBe("the September invoice");
	});

	it("drops the untitled placeholder a fresh conversation carries", () => {
		expect(
			buildConversationSeeds(
				[{ id: "c1", title: "New Conversation", updatedAt: 1 }],
				"x",
			),
		).toEqual([]);
	});

	it("drops every placeholder the rest of the app knows about", () => {
		// The set is shared with isPlaceholderConversationTitle rather than
		// re-listed here, so "Conversation" and a whitespace-only title go too.
		expect(
			buildConversationSeeds(
				[
					{ id: "c1", title: "Conversation", updatedAt: 1 },
					{ id: "c2", title: "  new   conversation ", updatedAt: 2 },
					{ id: "c3", title: "   ", updatedAt: 3 },
				],
				"x",
			),
		).toEqual([]);
	});

	it("fills the Atlas template with the job title and shortens the chip face", () => {
		const [job] = buildAtlasSeeds(
			[
				{
					id: "j1",
					title: "Hungarian EV charging subsidies, 2024-2026",
					updatedAt: 700,
					status: "queued",
				},
			],
			"Atlas · unfinished",
		);
		const rendered = renderHomeSuggestion(
			{ ...(job as HomeSuggestionSeed), actedOn: false },
			"en",
		);
		expect(rendered.text).toBe(
			"Pick up “Hungarian EV charging subsidies, 2024-2026” again",
		);
		expect(rendered.label).toBe("Pick up Hungarian EV charging…");
	});

	it("renders in Hungarian when that is the user's language", () => {
		const [job] = buildAtlasSeeds(
			[{ id: "j1", title: "EU battery rules", updatedAt: 1, status: "queued" }],
			"Atlas",
		);
		expect(
			renderHomeSuggestion(
				{ ...(job as HomeSuggestionSeed), actedOn: false },
				"hu",
			).text,
		).toBe("Folytassuk ezt: „EU battery rules”");
	});
});

describe("rankHomeSuggestionSeeds", () => {
	it("orders by the recency of the underlying object", () => {
		const ranked = rankHomeSuggestionSeeds(
			[
				seed({ key: "a", objectUpdatedAt: 100 }),
				seed({ key: "b", objectUpdatedAt: 300 }),
				seed({ key: "c", objectUpdatedAt: 200 }),
			],
			new Set(),
		);
		expect(ranked.map((item) => item.key)).toEqual(["b", "c", "a"]);
	});

	it("sinks an acted-on candidate below every fresh one, however recent", () => {
		const ranked = rankHomeSuggestionSeeds(
			[
				seed({ key: "acted", objectUpdatedAt: 9_000 }),
				seed({ key: "fresh", objectUpdatedAt: 10 }),
			],
			new Set(["acted"]),
		);
		expect(ranked.map((item) => item.key)).toEqual(["fresh", "acted"]);
		expect(ranked[0]?.actedOn).toBe(false);
		expect(ranked[1]?.actedOn).toBe(true);
	});

	it("still orders the acted-on block by recency", () => {
		const ranked = rankHomeSuggestionSeeds(
			[
				seed({ key: "old-acted", objectUpdatedAt: 1 }),
				seed({ key: "new-acted", objectUpdatedAt: 5 }),
				seed({ key: "fresh", objectUpdatedAt: 3 }),
			],
			new Set(["old-acted", "new-acted"]),
		);
		expect(ranked.map((item) => item.key)).toEqual([
			"fresh",
			"new-acted",
			"old-acted",
		]);
	});

	it("breaks a dead tie on the key rather than at random", () => {
		const input = [
			seed({ key: "zeta", objectUpdatedAt: 100 }),
			seed({ key: "alpha", objectUpdatedAt: 100 }),
		];
		expect(
			rankHomeSuggestionSeeds(input, new Set()).map((item) => item.key),
		).toEqual(["alpha", "zeta"]);
		// Reproducible: the same world always produces the same rail.
		expect(
			rankHomeSuggestionSeeds([...input].reverse(), new Set()).map(
				(item) => item.key,
			),
		).toEqual(["alpha", "zeta"]);
	});

	it("keeps the first of two seeds sharing a key", () => {
		const ranked = rankHomeSuggestionSeeds(
			[
				seed({ key: "dup", source: "first" }),
				seed({ key: "dup", source: "second" }),
			],
			new Set(),
		);
		expect(ranked).toHaveLength(1);
		expect(ranked[0]?.source).toBe("first");
	});

	it("returns nothing for a user with no candidates at all", () => {
		expect(rankHomeSuggestionSeeds([], new Set())).toEqual([]);
	});
});
