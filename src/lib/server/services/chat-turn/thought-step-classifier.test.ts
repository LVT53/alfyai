import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES } from "$lib/response-activity-types";
import * as schema from "$lib/server/db/schema";
import { deriveReasoningSpineState } from "$lib/utils/reasoning-spine";

// Same seam turn-acknowledgment.test.ts mocks — every classifier call funnels
// through this one control-model entrypoint.
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

// Wraps the REAL resolveThoughtStepAnchorSpan by default (so most tests get
// genuine anchor resolution), but lets one test force it to report "cannot
// resolve" to prove the session's own emission path actually consults it and
// refuses to emit when it does.
const resolveThoughtStepAnchorSpanMock = vi.fn();
vi.mock("./thought-steps", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./thought-steps")>();
	resolveThoughtStepAnchorSpanMock.mockImplementation(
		actual.resolveThoughtStepAnchorSpan,
	);
	return {
		...actual,
		resolveThoughtStepAnchorSpan: resolveThoughtStepAnchorSpanMock,
	};
});

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function controlModelResult(overrides: {
	text: string;
	modelId?: string;
	modelDisplayName?: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}) {
	return {
		text: overrides.text,
		rawResponse: null,
		modelId: overrides.modelId ?? "model2",
		modelDisplayName: overrides.modelDisplayName ?? "Model Two",
		usage: overrides.usage ?? {
			promptTokens: 30,
			completionTokens: 10,
			totalTokens: 40,
		},
	};
}

describe("classifyThoughtStepChunk", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-thought-step-classifier-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		sendJsonControlMessageMock.mockReset();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// db module may not have been imported by this test
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort
		}
	});

	it("returns a new_step verdict with the class and a verbatim entity, and records cost", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"recalling-context","entity":"the user\'s earlier message"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText:
				"Let me recall the user's earlier message about their preferences.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "recalling-context",
			entity: "the user's earlier message",
		});

		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{
				thinkingMode?: string;
				temperature?: number;
				jsonSchema?: { name?: string };
				signal?: AbortSignal;
			},
		];
		expect(message).toBe(
			"Let me recall the user's earlier message about their preferences.",
		);
		expect(modelId).toBe("model2");
		expect(options.thinkingMode).toBe("off");
		expect(options.jsonSchema?.name).toBe("thought_step_classification");
		expect(options.signal).toBeInstanceOf(AbortSignal);

		// ADR-0047 — same generic cost path P2 uses, feature-tagged distinctly.
		const rows = new Database(dbPath)
			.prepare("SELECT message_id, model_id FROM usage_events")
			.all() as Array<{ message_id: string; model_id: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].message_id).toMatch(/^control:thought_step_classifier:/);
	});

	it("drops an entity that is not a verbatim substring of the reasoning CHUNK (honesty rule)", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				// Paraphrased, not copied verbatim from the chunk below.
				text: '{"verdict":"new_step","activityClass":"weighing-options","entity":"a completely different topic"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "Comparing option A against option B for this case.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "weighing-options",
		});
	});

	// Amendment (2026-08-16) to ADR-0056 — "constrained, entity-grounded
	// summarization supersedes class-only wording". The runtime tether guard.
	it("keeps a summary that carries at least one verbatim content-word tether to the reasoning chunk", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"weighing-options","summary":"Comparing option A against option B"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "Comparing option A against option B for this case.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "weighing-options",
			summary: "Comparing option A against option B",
		});
	});

	it("drops a summary with NO verbatim content-word tether to the chunk, but still emits the step's class (floor never drops below class-only)", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"weighing-options","summary":"Pondering something else entirely"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "Comparing option A against option B for this case.",
			currentActivityClass: null,
		});

		// No `summary` key at all — the step is still classified, exactly the
		// pre-amendment class-only shape.
		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "weighing-options",
		});
	});

	it('drops a summary whose only overlap with the chunk is stop words ("the"/"is"/"a" do not count as a tether)', async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"checking-details","summary":"This is a review of that"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "The assistant is double-checking the numbers again.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "checking-details",
		});
	});

	// FIX 3 [HIGH] — the runtime external-action denylist guard. A summary
	// can pass the verbatim-content-word tether (every word genuinely copied
	// from the chunk) while still ASSERTING that an external action
	// happened — "Searching flight prices for Paris" is fully tethered to a
	// chunk that mentions flight prices and Paris, yet it falsely implies a
	// real search occurred from private reasoning, which is never an event
	// log. This must be dropped even though it is otherwise well-tethered.
	it("drops an EN summary asserting an external action, even though it is otherwise verbatim-tethered", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"working-through-logic","summary":"Searching flight prices for Paris"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText:
				"I should think through flight prices for Paris before answering.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "working-through-logic",
		});
	});

	it("drops a HU summary asserting an external action (keres stem), even though it is otherwise verbatim-tethered", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"working-through-logic","summary":"Repülőjegyárak keresése Párizsba"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText:
				"Meg kell gondolnom a repülőjegyárakat Párizsba mielőtt válaszolok.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "working-through-logic",
		});
	});

	it("keeps a purely-internal summary that names no external action", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"weighing-options","summary":"Weighing tradeoffs between caching and recomputation"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText:
				"There is a tradeoff between caching results and recomputation each time.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "weighing-options",
			summary: "Weighing tradeoffs between caching and recomputation",
		});
	});

	it("keeps both a tethered summary and a verbatim entity together on the same new_step result", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"recalling-context","summary":"Recalling the user\'s earlier message","entity":"the user\'s earlier message"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText:
				"Let me recall the user's earlier message about their preferences.",
			currentActivityClass: null,
		});

		expect(result).toEqual({
			verdict: "new_step",
			activityClass: "recalling-context",
			entity: "the user's earlier message",
			summary: "Recalling the user's earlier message",
		});
	});

	it("returns a bare continuation verdict, carrying no class or entity", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({ text: '{"verdict":"continuation"}' }),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "...and continuing along the same line of thought.",
			currentActivityClass: "working-through-logic",
		});

		expect(result).toEqual({ verdict: "continuation" });
	});

	it("rejects an activity class outside the closed enum", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({
				text: '{"verdict":"new_step","activityClass":"searching_the_web"}',
			}),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "Time to look this up.",
			currentActivityClass: null,
		});

		expect(result).toBeNull();
	});

	it("returns null for a new_step verdict missing its required activityClass", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({ text: '{"verdict":"new_step"}' }),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		const result = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "Some reasoning fragment.",
			currentActivityClass: null,
		});

		expect(result).toBeNull();
	});

	it("returns null on malformed JSON without throwing", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockResolvedValue(
			controlModelResult({ text: "not json at all" }),
		);

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		await expect(
			classifyThoughtStepChunk({
				userId: "u1",
				conversationId: "conv-1",
				chunkText: "Some reasoning fragment.",
				currentActivityClass: null,
			}),
		).resolves.toBeNull();
	});

	it("falls back silently to null on control-model rejection/timeout", async () => {
		openSeedDatabase().sqlite.close();
		sendJsonControlMessageMock.mockRejectedValue(new Error("upstream timeout"));

		const { classifyThoughtStepChunk } = await import(
			"./thought-step-classifier"
		);
		await expect(
			classifyThoughtStepChunk({
				userId: "u1",
				conversationId: "conv-1",
				chunkText: "Some reasoning fragment.",
				currentActivityClass: null,
			}),
		).resolves.toBeNull();

		const count = (
			new Database(dbPath)
				.prepare("SELECT COUNT(*) AS n FROM usage_events")
				.get() as { n: number }
		).n;
		expect(count).toBe(0);
	});

	it("enforces a hard concurrency cap of 1 — never queues behind a full instance", async () => {
		openSeedDatabase().sqlite.close();
		const {
			MAX_CONCURRENT_THOUGHT_STEP_CLASSIFIER_CALLS,
			classifyThoughtStepChunk,
		} = await import("./thought-step-classifier");
		expect(MAX_CONCURRENT_THOUGHT_STEP_CLASSIFIER_CALLS).toBe(1);

		let release!: () => void;
		sendJsonControlMessageMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve(controlModelResult({ text: '{"verdict":"continuation"}' }));
				}),
		);

		const inFlight = classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "First in-flight fragment.",
			currentActivityClass: null,
		});
		await vi.waitFor(() =>
			expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1),
		);

		const overCapResult = await classifyThoughtStepChunk({
			userId: "u1",
			conversationId: "conv-1",
			chunkText: "One too many.",
			currentActivityClass: null,
		});

		expect(overCapResult).toBeNull();
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);

		release();
		await inFlight;
	});
});

// Amendment (2026-08-16) to ADR-0056 — direct unit coverage of the runtime
// entity-grounding guard's content-word/stop-word boundary, independent of
// the control-model plumbing exercised above.
describe("hasVerbatimContentWordTether", () => {
	it("is tethered when a substantive word from the summary appears verbatim in the anchored text", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		expect(
			hasVerbatimContentWordTether(
				"Weighing the budget against the timeline",
				"Comparing the proposed budget with last quarter's numbers.",
			),
		).toBe(true);
	});

	it("is NOT tethered when every word the summary shares with the text is a stop word", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		// "the"/"is"/"a" are the ADR amendment's own named examples of words
		// that must never count as a tether on their own.
		expect(
			hasVerbatimContentWordTether(
				"This is a summary of that",
				"The assistant is reviewing the earlier draft again.",
			),
		).toBe(false);
	});

	it("is NOT tethered by trivial (under-3-character) tokens even when they match", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		expect(hasVerbatimContentWordTether("It is ok", "ok, let us proceed")).toBe(
			false,
		);
	});

	it("is case-insensitive", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		expect(
			hasVerbatimContentWordTether(
				"WEIGHING the BUDGET carefully",
				"comparing the proposed budget line by line",
			),
		).toBe(true);
	});

	// FIX 1 [HIGH] — the tether must match WHOLE WORDS, not raw substrings.
	// A short content-word ("cat") that merely nests inside a longer, wholly
	// unrelated real word ("location") must NOT count as a tether — that
	// would let a fabricated word sneak past the leash just because it
	// happens to be a substring of something genuine in the span.
	it("is NOT tethered when the only overlap is a nested substring, not a whole word (fabricated word smuggled inside a real one)", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		// "cat" is a substring of "location" but never appears as its own word
		// in the anchored text — a summary claiming "cat" must be rejected.
		expect(
			hasVerbatimContentWordTether(
				"Checking on the cat now",
				"Figuring out the best location for the meeting.",
			),
		).toBe(false);
	});

	it('is NOT tethered when the only overlap is a nested substring the other direction ("art" inside "start")', async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		expect(
			hasVerbatimContentWordTether(
				"Reviewing the art collection",
				"Deciding when to start the next phase of the plan.",
			),
		).toBe(false);
	});

	it("IS tethered when the shared word is a genuine standalone whole-word match", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		expect(
			hasVerbatimContentWordTether(
				"Checking on the cat today",
				"The cat needs to go to the vet this week.",
			),
		).toBe(true);
	});

	// FIX 4 [MED] — the tokenizer must be Unicode-aware so accented Hungarian
	// words are not shredded into sub-3-character fragments at the accent
	// boundary (the ASCII-only regex splits "irány" into "ir" + "ny", both
	// under the 3-char floor and therefore silently dropped, even though
	// "irány" is the ONLY substantive word the summary and span truthfully
	// share — every other shared word here is a stop word or absent, so the
	// ASCII-only tokenizer has nothing else to fall back on and the tether
	// fails outright).
	it("is tethered on a genuine shared accented Hungarian word that the ASCII-only tokenizer would have shredded away", async () => {
		const { hasVerbatimContentWordTether } = await import(
			"./thought-step-classifier"
		);
		expect(
			hasVerbatimContentWordTether(
				"Working through irány carefully",
				"The current irány needs to be settled before we continue.",
			),
		).toBe(true);
	});
});

// FIX 3 [HIGH] — direct unit coverage of the runtime external-action
// denylist guard, independent of the control-model plumbing exercised
// above. This is defense-in-depth: it catches a summary whose TEXT asserts
// an external action (searching/fetching/browsing/etc.) even when the
// summary is otherwise perfectly verbatim-tethered, which the tether check
// alone can never catch (tether only proves a word is genuine, not that it
// doesn't assert an action).
describe("assertsExternalAction", () => {
	it("matches a plain EN search verb", async () => {
		const { assertsExternalAction } = await import("./thought-step-classifier");
		expect(assertsExternalAction("Searching flight prices for Paris")).toBe(
			true,
		);
	});

	it('matches "look up" but NOT plain "looking at" (internal reasoning uses "looking at" routinely)', async () => {
		const { assertsExternalAction } = await import("./thought-step-classifier");
		expect(assertsExternalAction("Looking up the exact figure")).toBe(true);
		expect(assertsExternalAction("Looking at the budget numbers again")).toBe(
			false,
		);
	});

	it("matches other EN external-action stems: fetch, browse, retrieve, query, download, google, read the, check online", async () => {
		const { assertsExternalAction } = await import("./thought-step-classifier");
		expect(assertsExternalAction("Fetching the latest exchange rate")).toBe(
			true,
		);
		expect(assertsExternalAction("Browsing recent reviews of the hotel")).toBe(
			true,
		);
		expect(
			assertsExternalAction("Retrieving the current weather forecast"),
		).toBe(true);
		expect(assertsExternalAction("Querying the flight database")).toBe(true);
		expect(assertsExternalAction("Downloading the attached spreadsheet")).toBe(
			true,
		);
		expect(assertsExternalAction("Googling the company's founding date")).toBe(
			true,
		);
		expect(assertsExternalAction("Reading the linked article now")).toBe(true);
		expect(assertsExternalAction("Checking online for current prices")).toBe(
			true,
		);
	});

	it("matches HU external-action stems (keres/megkeres/letölt/böngész/lekér)", async () => {
		const { assertsExternalAction } = await import("./thought-step-classifier");
		expect(assertsExternalAction("Repülőjegyárak keresése Párizsba")).toBe(
			true,
		);
		expect(assertsExternalAction("Megkeresem a legfrissebb árfolyamot")).toBe(
			true,
		);
		expect(assertsExternalAction("A csatolt fájl letöltése folyamatban")).toBe(
			true,
		);
		expect(assertsExternalAction("Böngészem a legutóbbi véleményeket")).toBe(
			true,
		);
		expect(assertsExternalAction("Lekérem a jelenlegi árfolyamot")).toBe(true);
	});

	it('does NOT false-positive on the unrelated Hungarian word "keresztül" (through), which nests the "keres" stem', async () => {
		const { assertsExternalAction } = await import("./thought-step-classifier");
		expect(
			assertsExternalAction("A probléma keresztül gondolása most zajlik"),
		).toBe(false);
	});

	it("does NOT match a purely-internal summary that names no external action", async () => {
		const { assertsExternalAction } = await import("./thought-step-classifier");
		expect(
			assertsExternalAction(
				"Weighing tradeoffs between caching and recomputation",
			),
		).toBe(false);
	});
});

describe("createThoughtStepClassifierSession", () => {
	beforeEach(() => {
		resolveThoughtStepAnchorSpanMock.mockClear();
	});

	function fakeClock(startMs = 0) {
		let now = startMs;
		return {
			now: () => now,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	it("fires the first sample immediately once triggered, then withholds the next one until the minimum interval elapses", async () => {
		const {
			createThoughtStepClassifierSession,
			THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS,
		} = await import("./thought-step-classifier");
		const classify = vi.fn().mockResolvedValue(null);
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
		});

		// There is no prior sample to rate-limit against yet, so the first
		// marker-triggered chunk of the turn samples right away.
		session.onReasoningDelta("First, let me think about this. ");
		expect(classify).toHaveBeenCalledTimes(1);
		// Let the (null-resolving) in-flight call settle before continuing, so
		// `sampleInFlight` — not the interval floor — isn't what's gating the
		// next call below.
		await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		await Promise.resolve();

		// A second marker-laden chunk arriving before the interval elapses is
		// withheld.
		clock.advance(THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS - 1);
		session.onReasoningDelta("Now, still within the rate-limit window. ");
		expect(classify).toHaveBeenCalledTimes(1);

		// Once the interval elapses, the next marker-laden chunk samples again.
		clock.advance(2);
		session.onReasoningDelta("So, the interval has elapsed. ");
		expect(classify).toHaveBeenCalledTimes(2);
	});

	it("does not sample without a discourse-marker trigger, even after the interval elapses", async () => {
		const {
			createThoughtStepClassifierSession,
			THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS,
		} = await import("./thought-step-classifier");
		const classify = vi.fn().mockResolvedValue(null);
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
		});

		session.onReasoningDelta("plain reasoning text with nothing distinctive");
		clock.advance(THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS + 1000);
		session.onReasoningDelta("more plain reasoning without any trigger word");

		expect(classify).not.toHaveBeenCalled();
	});

	it("creates a new, correctly anchored classified step, with impliesExternalAction always false", async () => {
		const {
			createThoughtStepClassifierSession,
			THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS,
		} = await import("./thought-step-classifier");
		const onStep = vi.fn();
		const classify = vi.fn().mockResolvedValue({
			verdict: "new_step" as const,
			activityClass: "understanding-request" as const,
		});
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
			onStep,
		});

		session.onReasoningDelta("Preamble text before anything interesting. ");
		clock.advance(THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS + 1);
		session.onReasoningDelta("First, let me understand what is being asked. ");
		await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(1));

		const steps = session.getSteps();
		expect(steps).toHaveLength(1);
		expect(steps[0].source).toBe("classified");
		expect(steps[0].activityClass).toBe("understanding-request");
		expect(steps[0].impliesExternalAction).toBe(false);
		expect(steps[0].anchor).not.toBeNull();
		expect(steps[0].anchor?.end).toBeGreaterThan(steps[0].anchor?.start ?? 0);
		expect(onStep).toHaveBeenCalledWith(steps[0]);
	});

	// Amendment (2026-08-16) to ADR-0056 — the session trusts whatever
	// `summary` the injected `classify` returns (the tether guard itself is
	// `classifyThoughtStepChunk`'s job, exercised directly above; this proves
	// the session carries the field through onto the emitted step unchanged,
	// exactly like it already does for `entity`).
	it("carries a classify()-provided summary onto the emitted step", async () => {
		const {
			createThoughtStepClassifierSession,
			THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS,
		} = await import("./thought-step-classifier");
		const onStep = vi.fn();
		const classify = vi.fn().mockResolvedValue({
			verdict: "new_step" as const,
			activityClass: "weighing-options" as const,
			summary: "Comparing option A against option B",
		});
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
			onStep,
		});

		session.onReasoningDelta("Preamble text before anything interesting. ");
		clock.advance(THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS + 1);
		session.onReasoningDelta("Comparing option A against option B now. ");
		await vi.waitFor(() => expect(onStep).toHaveBeenCalledTimes(1));

		const steps = session.getSteps();
		expect(steps).toHaveLength(1);
		expect(steps[0].summary).toBe("Comparing option A against option B");
	});

	it("extends the current step's anchor on a continuation verdict instead of adding a new step", async () => {
		const { createThoughtStepClassifierSession } = await import(
			"./thought-step-classifier"
		);
		const classify = vi
			.fn()
			.mockResolvedValueOnce({
				verdict: "new_step" as const,
				activityClass: "checking-details" as const,
			})
			.mockResolvedValueOnce({ verdict: "continuation" as const });
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
		});

		clock.advance(10_000);
		session.onReasoningDelta("Now let me check the details carefully. ");
		await vi.waitFor(() => expect(session.getSteps()).toHaveLength(1));
		const anchorAfterFirstSample = session.getSteps()[0].anchor;

		clock.advance(6_000);
		session.onReasoningDelta("So the same check continues a while longer. ");
		// Wait for the OBSERVABLE EFFECT (the anchor actually widening), not
		// merely for `classify` to have been invoked a second time — the mock
		// function call itself is synchronous, but applying its resolved
		// result happens a couple of microtask hops later.
		await vi.waitFor(() =>
			expect(session.getSteps()[0]?.anchor?.end).toBeGreaterThan(
				anchorAfterFirstSample?.end ?? 0,
			),
		);

		const steps = session.getSteps();
		expect(steps).toHaveLength(1);
		expect(steps[0].anchor?.start).toBe(anchorAfterFirstSample?.start);
	});

	it("never emits a step whose anchor cannot be resolved against the reasoning text", async () => {
		const { createThoughtStepClassifierSession } = await import(
			"./thought-step-classifier"
		);
		resolveThoughtStepAnchorSpanMock.mockReturnValueOnce(null);
		const onStep = vi.fn();
		const classify = vi.fn().mockResolvedValue({
			verdict: "new_step" as const,
			activityClass: "drafting-approach" as const,
		});
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
			onStep,
		});

		clock.advance(10_000);
		session.onReasoningDelta("Finally, let me draft the approach now. ");
		await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));

		expect(session.getSteps()).toEqual([]);
		expect(onStep).not.toHaveBeenCalled();
	});

	it("stops hard on stop() — no further samples fire, and a result already in flight is discarded", async () => {
		const {
			createThoughtStepClassifierSession,
			THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS,
		} = await import("./thought-step-classifier");
		let resolveClassify!: (value: unknown) => void;
		const classify = vi.fn().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveClassify = resolve;
				}),
		);
		const onStep = vi.fn();
		const clock = fakeClock();
		const session = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
			onStep,
		});

		clock.advance(10_000);
		session.onReasoningDelta("First, kick off a sample that will hang. ");
		expect(classify).toHaveBeenCalledTimes(1);

		// The answer starts before the in-flight classify call resolves.
		session.stop();
		resolveClassify({
			verdict: "new_step",
			activityClass: "understanding-request",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(session.getSteps()).toEqual([]);
		expect(onStep).not.toHaveBeenCalled();

		// Further reasoning deltas (there should be none post-answer in
		// practice, but proving the hard stop) never trigger another sample.
		clock.advance(THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS + 1000);
		session.onReasoningDelta("Now, another marker-laden fragment arrives. ");
		expect(classify).toHaveBeenCalledTimes(1);
	});

	it("degrades to zero steps, silently and without throwing, when disabled or when every sample rejects — the deterministic spine is unaffected", async () => {
		const {
			createThoughtStepClassifierSession,
			THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS,
		} = await import("./thought-step-classifier");
		const classify = vi.fn().mockRejectedValue(new Error("control model down"));
		const clock = fakeClock();
		const rejectingSession = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			classify,
			now: clock.now,
		});

		clock.advance(10_000);
		expect(() =>
			rejectingSession.onReasoningDelta(
				"First, this fragment triggers a sample that will reject. ",
			),
		).not.toThrow();
		await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
		expect(rejectingSession.getSteps()).toEqual([]);

		const disabledSession = createThoughtStepClassifierSession({
			userId: "u1",
			conversationId: "conv-1",
			enabled: false,
			classify,
			now: clock.now,
		});
		clock.advance(THOUGHT_STEP_MIN_SAMPLE_INTERVAL_MS + 1000);
		disabledSession.onReasoningDelta(
			"So, this session is fully disabled from the start. ",
		);
		expect(classify).toHaveBeenCalledTimes(1); // unchanged — disabled never sampled
		expect(disabledSession.getSteps()).toEqual([]);

		// This module is pure enrichment: the P1 deterministic spine's own
		// pure function is completely unaffected by, and has no dependency
		// on, anything above.
		expect(
			deriveReasoningSpineState({ answerStarted: false, deltaStalled: false }),
		).toBe("reasoning_active");
	});

	it("the closed activity-class enum names only internal/cognitive work — no member implies an external action", async () => {
		const actionLikePattern =
			/search|fetch|browse|read.*account|call.*tool|retrieve|download|send|post|email|calendar/i;
		for (const activityClass of THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES) {
			expect(activityClass).not.toMatch(actionLikePattern);
		}
	});
});
