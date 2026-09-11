import { describe, expect, it } from "vitest";
import type { ConnectionProvider } from "$lib/server/db/schema";
import { grantedCapabilitiesFor } from "./connections/granted";
import { PROVIDER_META } from "./connections/registry";
import {
	buildAtlasSeeds,
	buildConnectionSeeds,
	buildConversationSeeds,
	buildMemorySeeds,
	fillTemplate,
	type HomeSuggestionKind,
	type HomeSuggestionSeed,
	interleaveHomeSuggestionSeeds,
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

	it("ignores a capability the provider explicitly granted around", () => {
		// A NON-EMPTY grant list is the provider's real answer, so it narrows.
		expect(
			buildConnectionSeeds([
				connection({
					grantedCapabilities: ["contacts"],
					capabilities: ["files", "contacts"],
				}),
			]),
		).toEqual([]);
	});

	it("treats an empty grant list as unknown, not as a refusal", () => {
		// The defect: `grantedCapabilities` is derived and scope-based for
		// google/onedrive only, so a Google row whose stored scopes do not
		// contain the literal readonly scope derives []. Intersecting with []
		// silently emptied the rail for a connection the rest of the app
		// happily uses — granted.ts's own rule is that "we don't know" must
		// never render as "the provider refused".
		const [calendar] = buildConnectionSeeds([
			connection({
				id: "g1",
				label: "Google",
				displayName: "Google",
				grantedCapabilities: [],
				capabilities: ["calendar"],
			}),
		]);
		expect(calendar?.key).toBe("calendar:g1");
	});

	it("treats an absent grant list the same way (fixtures omit it)", () => {
		const [files] = buildConnectionSeeds([
			connection({ grantedCapabilities: undefined, capabilities: ["files"] }),
		]);
		expect(files?.key).toBe("files:conn-1");
	});

	it("does not gate on defaultOn — a chip is the user asking", () => {
		// defaultOn answers "consult this account WITHOUT being asked", which is
		// a different question from "may this account back a suggestion".
		const seeds = buildConnectionSeeds([
			connection({ capabilities: ["files"], grantedCapabilities: ["files"] }),
		]);
		expect(seeds).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// The defect: an owner with six connected accounts saw three recent chats.
// ---------------------------------------------------------------------------

/**
 * A connection row as it actually reaches the engine: the capabilities the
 * provider's own connect flow writes, and the grant list derived from them by
 * the REAL `grantedCapabilitiesFor` rather than one restated by hand. A test
 * that writes its own grant list cannot catch a grant list that comes back
 * empty, which is exactly what happened.
 */
function realConnection(params: {
	id: string;
	provider: ConnectionProvider;
	label: string;
	capabilities: string[];
	oauthScopes?: string[];
	config?: Record<string, unknown>;
}) {
	const capabilities = params.capabilities;
	const oauthScopes = params.oauthScopes ?? [];
	const config = params.config ?? {};
	return {
		id: params.id,
		label: params.label,
		displayName: PROVIDER_META[params.provider].displayName,
		status: "connected",
		capabilities,
		grantedCapabilities: grantedCapabilitiesFor({
			provider: params.provider,
			oauthScopes,
			capabilities,
			config,
		}),
		updatedAt: 1_000,
		lastUsedAt: null,
	};
}

describe("buildConnectionSeeds — every provider the owner has connected", () => {
	const cases: Array<{
		provider: ConnectionProvider;
		label: string;
		capabilities: string[];
		oauthScopes?: string[];
		key: string;
		kind: HomeSuggestionKind;
		text: string;
	}> = [
		{
			provider: "nextcloud",
			label: "Nextcloud",
			capabilities: ["files"],
			key: "files:c1",
			kind: "files",
			text: "Summarise the last Nextcloud upload",
		},
		{
			provider: "google",
			label: "Google",
			capabilities: ["calendar"],
			oauthScopes: [
				"https://www.googleapis.com/auth/calendar.readonly",
				"https://www.googleapis.com/auth/userinfo.email",
			],
			key: "calendar:c1",
			kind: "calendar",
			text: "Ask about this week's calendar",
		},
		{
			provider: "imap",
			label: "Email",
			capabilities: ["email"],
			key: "email:c1",
			kind: "email",
			text: "Check what needs a reply",
		},
		{
			provider: "immich",
			label: "Immich",
			capabilities: ["photos"],
			key: "photos:c1",
			kind: "photos",
			text: "Find the photos from last weekend",
		},
		{
			provider: "owntracks",
			label: "OwnTracks",
			capabilities: ["location"],
			key: "location:c1",
			kind: "location",
			text: "How far am I from home right now?",
		},
		{
			provider: "github",
			label: "GitHub",
			capabilities: ["repos"],
			key: "repositories:c1",
			kind: "repositories",
			text: "What changed in my GitHub repositories this week",
		},
	];

	for (const example of cases) {
		it(`produces a ${example.kind} candidate for a connected ${example.provider}`, () => {
			const seeds = buildConnectionSeeds([
				realConnection({
					id: "c1",
					provider: example.provider,
					label: example.label,
					capabilities: example.capabilities,
					oauthScopes: example.oauthScopes,
				}),
			]);
			expect(seeds).toHaveLength(1);
			expect(seeds[0]?.key).toBe(example.key);
			expect(seeds[0]?.kind).toBe(example.kind);
			expect(seeds[0]?.source).toBe(example.label);
			expect(
				renderHomeSuggestion(
					{ ...(seeds[0] as HomeSuggestionSeed), actedOn: false },
					"en",
				).text,
			).toBe(example.text);
		});
	}

	it("gives the owner's six accounts six candidates, not three", () => {
		const seeds = buildConnectionSeeds(
			cases.map((example, index) =>
				realConnection({
					id: `c${index}`,
					provider: example.provider,
					label: example.label,
					capabilities: example.capabilities,
					oauthScopes: example.oauthScopes,
				}),
			),
		);
		expect(seeds).toHaveLength(6);
		expect(seeds.map((seed) => seed.kind).sort()).toEqual([
			"calendar",
			"email",
			"files",
			"location",
			"photos",
			"repositories",
		]);
	});

	it("names the repository when one is known", () => {
		const [repo] = buildConnectionSeeds(
			[
				realConnection({
					id: "gh",
					provider: "github",
					label: "GitHub",
					capabilities: ["repos"],
				}),
			],
			{ recentRepoName: "alfyai" },
		);
		expect(repo?.textKey).toBe("home.suggest.repoNamed");
		expect(
			renderHomeSuggestion(
				{ ...(repo as HomeSuggestionSeed), actedOn: false },
				"en",
			).text,
		).toBe("What changed in alfyai this week");
	});

	it("renders every new kind in Hungarian too", () => {
		const seeds = buildConnectionSeeds([
			realConnection({
				id: "im",
				provider: "immich",
				label: "Immich",
				capabilities: ["photos"],
			}),
			realConnection({
				id: "ot",
				provider: "owntracks",
				label: "OwnTracks",
				capabilities: ["location"],
			}),
		]);
		const rendered = seeds.map(
			(seed) => renderHomeSuggestion({ ...seed, actedOn: false }, "hu").text,
		);
		expect(rendered).toEqual([
			"Keresd meg a múlt hétvégi fotókat",
			"Milyen messze vagyok most otthonról?",
		]);
	});

	it("gives a Nextcloud account that also serves CalDAV both chips", () => {
		const seeds = buildConnectionSeeds([
			realConnection({
				id: "nc",
				provider: "caldav",
				label: "Nextcloud calendar",
				capabilities: ["tasks", "calendar"],
				config: {
					taskListUrls: ["https://cloud.example/remote.php/dav/tasks/a/"],
					calendarUrls: ["https://cloud.example/remote.php/dav/calendars/a/"],
				},
			}),
		]);
		// `tasks` has no template yet; `calendar` does, and must not be lost.
		expect(seeds.map((seed) => seed.kind)).toEqual(["calendar"]);
	});
});

describe("interleaveHomeSuggestionSeeds — one chip per source, in order", () => {
	function ranked(
		items: Array<{ key: string; kind: HomeSuggestionKind; actedOn?: boolean }>,
	) {
		return items.map((item) => ({
			...seed({ key: item.key, kind: item.kind }),
			actedOn: item.actedOn ?? false,
		}));
	}

	it("never deals three chips from one source when other sources have any", () => {
		// The reported state: recent conversations are the freshest objects the
		// user owns, so ranking alone put three of them on the rail.
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "conversation:1", kind: "conversation" },
				{ key: "conversation:2", kind: "conversation" },
				{ key: "conversation:3", kind: "conversation" },
				{ key: "files:1", kind: "files" },
				{ key: "atlas:1", kind: "atlas" },
				{ key: "memory:1", kind: "memory" },
			]),
			9,
		);
		expect(dealt.slice(0, 3).map((item) => item.key)).toEqual([
			"files:1",
			"atlas:1",
			"memory:1",
		]);
	});

	it("deals in the fixed source order: connections, Atlas, memory, conversations", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "memory:1", kind: "memory" },
				{ key: "conversation:1", kind: "conversation" },
				{ key: "atlas:1", kind: "atlas" },
				{ key: "calendar:1", kind: "calendar" },
			]),
			9,
		);
		expect(dealt.map((item) => item.key)).toEqual([
			"calendar:1",
			"atlas:1",
			"memory:1",
			"conversation:1",
		]);
	});

	it("treats every connected account as ONE source, whatever it granted", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "calendar:1", kind: "calendar" },
				{ key: "files:1", kind: "files" },
				{ key: "photos:1", kind: "photos" },
				{ key: "conversation:1", kind: "conversation" },
			]),
			9,
		);
		// One connection chip, then the conversation, then the rest.
		expect(dealt.map((item) => item.key)).toEqual([
			"calendar:1",
			"conversation:1",
			"files:1",
			"photos:1",
		]);
	});

	it("rotates within the rule: the next deal of three spreads too", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "files:1", kind: "files" },
				{ key: "files:2", kind: "files" },
				{ key: "atlas:1", kind: "atlas" },
				{ key: "atlas:2", kind: "atlas" },
				{ key: "memory:1", kind: "memory" },
				{ key: "memory:2", kind: "memory" },
			]),
			9,
		);
		expect(dealt.slice(0, 3).map((item) => item.kind)).toEqual([
			"files",
			"atlas",
			"memory",
		]);
		// "another" advances by three; the second deal is a second round of the
		// same rule rather than two of whatever source had the most left.
		expect(dealt.slice(3, 6).map((item) => item.kind)).toEqual([
			"files",
			"atlas",
			"memory",
		]);
	});

	it("keeps rank order inside a source", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "conversation:new", kind: "conversation" },
				{ key: "conversation:old", kind: "conversation" },
			]),
			9,
		);
		expect(dealt.map((item) => item.key)).toEqual([
			"conversation:new",
			"conversation:old",
		]);
	});

	it("still sinks the acted-on block whole", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "conversation:1", kind: "conversation" },
				{ key: "files:1", kind: "files", actedOn: true },
				{ key: "atlas:1", kind: "atlas", actedOn: true },
			]),
			9,
		);
		expect(dealt.map((item) => item.key)).toEqual([
			"conversation:1",
			"files:1",
			"atlas:1",
		]);
	});

	it("falls back to one source when it is the only one there is", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked([
				{ key: "conversation:1", kind: "conversation" },
				{ key: "conversation:2", kind: "conversation" },
				{ key: "conversation:3", kind: "conversation" },
			]),
			9,
		);
		expect(dealt).toHaveLength(3);
	});

	it("caps the pool at the limit it is given", () => {
		const dealt = interleaveHomeSuggestionSeeds(
			ranked(
				Array.from({ length: 20 }, (_, index) => ({
					key: `conversation:${index}`,
					kind: "conversation" as const,
				})),
			),
			9,
		);
		expect(dealt).toHaveLength(9);
	});
});
