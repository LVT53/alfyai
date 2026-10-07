import { beforeEach, describe, expect, it, vi } from "vitest";

// Both transport helpers reach the control model, the cost ledger, and the
// abort-signal composer through dynamic imports. Mock all three so the pure
// module can be exercised hermetically (no real vLLM, no DB, no heavy graph).
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

const recordControlModelUsageMock = vi.fn(async () => {});
vi.mock("../analytics", () => ({
	recordControlModelUsage: recordControlModelUsageMock,
}));

vi.mock("./shared-normal-chat-model-run-helpers", () => ({
	createRequestAbortSignal: (timeoutMs: number, signal?: AbortSignal) =>
		signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined),
}));

import {
	askWithThinkingRetry,
	callShortLocalControlModel,
	generateShortLocalText,
	isHungarianText,
	isPlausibleShortText,
	isReasoningLeak,
	isRequestRestatement,
	resolveShortTextLanguage,
	stripLeakedThinking,
	unwrapJsonControlText,
} from "./short-local-text";

function controlResult(overrides: {
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
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
		},
	};
}

describe("isReasoningLeak", () => {
	it("flags leaked reasoning preambles", () => {
		for (const text of [
			"Here's a thinking process: 1. **Analyze User Input**",
			"Let me think about this problem",
			"Let me work through this step by step",
			"Okay, let me work through the summary",
			"First, let me analyze the request",
			"The user is asking about deployment",
			"This looks like a bug report",
		]) {
			expect(isReasoningLeak(text)).toBe(true);
		}
	});

	it("does not flag genuine short titles", () => {
		for (const text of [
			"React Component Basics",
			"How to Create React Components",
			"Debugging a JavaScript Undefined Error",
		]) {
			expect(isReasoningLeak(text)).toBe(false);
		}
	});
});

// The server drops the closing `</think>` from the text it returns but keeps the
// opener (observed on the real Flash-Next vLLM v0.31 through /tokenize and
// logprobs: the model emits <think> \n\n </think> \n\n and the response text
// reads "<think>\n\n\n\n..."). These are the real answers a title request got
// back with `enable_thinking: false` on the wire, 17.5% of 416 requests.
describe("stripLeakedThinking", () => {
	it("leaves an answer with no think marker untouched", () => {
		expect(stripLeakedThinking("Négyhetes kezdő futóedzésterv")).toEqual({
			kind: "text",
			text: "Négyhetes kezdő futóedzésterv",
		});
	});

	it("keeps the answer after an empty block whose closer the server dropped (the real shape, 86% of the leaks)", () => {
		for (const [raw, answer] of [
			[
				"<think>\n\n\n\nHavi százezer forint megtakarítási tippek",
				"Havi százezer forint megtakarítási tippek",
			],
			[
				"<think>\n\n\n\nSzja bevallás egy munkahely esetén",
				"Szja bevallás egy munkahely esetén",
			],
			[
				"<think>\n\n\n\nFast English Learning Daily",
				"Fast English Learning Daily",
			],
		]) {
			expect(stripLeakedThinking(raw)).toEqual({ kind: "text", text: answer });
		}
	});

	it("strips a closed block, as other servers return it", () => {
		expect(
			stripLeakedThinking(
				"<think>\nreasoning here\n</think>\n\nPython hibakeresés",
			),
		).toEqual({ kind: "text", text: "Python hibakeresés" });
		expect(stripLeakedThinking("<think>\n\n</think>\n\nHeti étrend")).toEqual({
			kind: "text",
			text: "Heti étrend",
		});
	});

	it("calls an opener with reasoning after it and no closer unclosed, whether it was cut off or the closer was dropped", () => {
		// Cut off at the 120-token cap: no answer exists.
		expect(
			stripLeakedThinking(
				'<think>\nThe user wants me to generate a concise conversation title (3-8 words) for a conversation about a Python "list index out of range" error.\n\nThe conversation is about debugging a Python list index error. Let me think of a concise title:\n\n- "Python list index out of range hiba" - 7 words\n\nI\'ll go with',
			),
		).toEqual({ kind: "unclosed" });
		// Closed by the model but the closer dropped: reasoning and answer cannot
		// be told apart any more, so it is not guessed at.
		expect(
			stripLeakedThinking(
				'<think>\nThe user wants me to generate a concise conversation title (3-8 words) based on the conversation about laptop recommendations. Let me create a short title in Hungarian.\n\n"Laptop ajánlás egyetemre 300 ezer forintból" - that\'s 6 words, fits the criteria.\n\n\nLaptop ajánlás egyetemre 300 ezer forintból',
			),
		).toEqual({ kind: "unclosed" });
	});

	it("calls an opener in the middle of the text unclosed", () => {
		expect(stripLeakedThinking("Heti étrend <think>\nlet me see")).toEqual({
			kind: "unclosed",
		});
	});

	it("is an empty answer, not an unclosed one, when nothing follows an empty opener", () => {
		expect(stripLeakedThinking("<think>\n\n")).toEqual({
			kind: "text",
			text: "",
		});
	});
});

describe("askWithThinkingRetry", () => {
	it("asks once when the first answer is usable", async () => {
		const ask = vi.fn(async () => "<think>\n\n\n\nHeti étrend");
		await expect(askWithThinkingRetry(ask)).resolves.toBe("Heti étrend");
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("asks once more when the first answer is an unclosed block, and uses the second", async () => {
		const ask = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("<think>\nThe user wants me to generate a title")
			.mockResolvedValueOnce("Heti étrend");
		await expect(askWithThinkingRetry(ask)).resolves.toBe("Heti étrend");
		expect(ask).toHaveBeenCalledTimes(2);
	});

	it("gives up after the one extra attempt, so the caller's own fallback applies", async () => {
		const ask = vi.fn(
			async () => "<think>\nThe user wants me to generate a title",
		);
		await expect(askWithThinkingRetry(ask)).resolves.toBeNull();
		expect(ask).toHaveBeenCalledTimes(2);
	});

	it("does not swallow a failed request", async () => {
		const ask = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(askWithThinkingRetry(ask)).rejects.toThrow("boom");
		expect(ask).toHaveBeenCalledTimes(1);
	});
});

// Everything below is what the real model wrote (Flash-Next, the app's own
// requests), not what a Hungarian preamble might look like: the reasoning the
// model produced about Hungarian conversations, and the status lines and
// headlines the app accepted before it knew these shapes.
describe("isReasoningLeak in both languages", () => {
	it("flags the Hungarian reasoning the model wrote about the request", () => {
		for (const text of [
			"A felhasználó magyarul kérdez: „Mikor ültessem el a paradicsompalántákat a kertben?”",
			"A felhasználó magyarul kér segítséget: heti étrend összeállítása, ami olcsó és gyorsan elkészíthető.",
			"A felhasználó egy heti étrendet kért, és az asszisztens egy konkrét, egyszerű hetitervet vázolt fel",
			"A felhasználó kérésére a rendszer egy rövid, magyar nyelvű címsort generál",
		]) {
			expect(isReasoningLeak(text), text).toBe(true);
		}
	});

	it("flags the English reasoning a rail summary came back with", () => {
		for (const text of [
			"The user wants a short Hungarian headline for a text describing a 4-week running plan.",
			"The user provided a short recipe for egg fried rice in Hungarian.",
			"The assistant provides a simple weekly diet plan including meals for each day and shopping tips.",
			"The response is in Hungarian, and it discusses the timing, location, and method for planting tomatoes.",
		]) {
			expect(isReasoningLeak(text), text).toBe(true);
		}
	});

	it("does not flag ordinary headlines and titles", () => {
		for (const text of [
			"Egyszerű heti étrend",
			"Indexelési hiba listákban",
			"Válasz Anna és Péter hétvégi vacsorájára",
			"Északi erkély növényei és öntözése",
			"A tojás, rizs és zöldségek felhasználásának módjai",
			"A CPU és GPU specifikációk mérlegelése a felhasználói igények szerint",
			"Daily Protein Intake Guidelines",
			"What Is a Mutex",
			// a title that only starts with the same words as a preamble
			"The Response Time Problem",
			"The Assistant Manager Handbook",
		]) {
			expect(isReasoningLeak(text), text).toBe(false);
		}
	});
});

// The status line is a conclusion of the reasoning. On Hungarian conversations
// the model reasons in Hungarian ("A felhasználó magyarul kérdez: ..."), and 6%
// of the status lines the app accepted (72 of 1,170) just said what was asked.
describe("isRequestRestatement", () => {
	it("flags the Hungarian status lines that say what was asked", () => {
		for (const text of [
			"A felhasználó olcsó és gyorsan elkészíthető heti étrendet kér.",
			"Budapesti három napos programot kért a felhasználó",
			"Négyhetes futóedzéstervet kért a kezdő felhasználó",
			"Tojás, rizs és zöldség alapú vacsoraötletek kérése",
			"Északi fekvésű erkélyre árnyéktűrő növények kérése",
			"Kezdő futóedzéstervet kért négy hétre",
			"Köszönő e-mailt kért a vendéglátónak a hétvégi vacsoráért",
			"A git pre-commit hook beállítását kérdezi",
			"Az egyszeres és kettős könyvelés különbségeit kérték",
			"A kérés a egyszeres és kettős könyvelés különbségét kérte",
			"A Városliget és Vajdahunyad helyszínekre fókuszált a kérés",
			"A 'eventual consistency' definícióját kérdezte magyarul",
			"Az egyszeres és kettős könyvelés különbségeit kell tisztázni magyarul.",
		]) {
			expect(isRequestRestatement(text), text).toBe(true);
		}
	});

	it("keeps the Hungarian status lines that state what the reasoning found or chose", () => {
		for (const text of [
			"A négy hetes futó-séta terv kereteit határozta meg",
			"A 300-as ársávban a Core i5 és Ryzen 5 modellek között választott",
			"A 7 napos étrendhez a tojás, csirkecomb, darált hús alapanyagokat választotta",
			"Husky-t választott a versioning miatt, chmod +x említése szükséges",
			"A havi százezer forint megtakarításának automatikus átutalással történő megvalósítása",
			"A munkáltató igazolt elszámolása esetén nem kell SZJA-bevallást benyújtani",
			// stems that only look alike: felhasználás (use), felhasználói (user-facing), kérdés (a question)
			"A tojás, rizs és zöldségek felhasználásának módjai",
			"A CPU és GPU specifikációk mérlegelése a felhasználói igények szerint",
			"A Budapest-Bécs vonat utazási idő és jegyár kérdését azonosította",
			"Tisztázó kérdések helyett kész terv adása",
		]) {
			expect(isRequestRestatement(text), text).toBe(false);
		}
	});

	it("keeps the English labels the status line has always dropped, and its ordinary lines", () => {
		for (const text of [
			"Latest user request: compare the two databases",
			"The user wants a leaderboard design",
			"The user's request about caching",
			"User request: build a rate limiter",
			"Task: shard the social graph",
			"The prompt is ambiguous",
		]) {
			expect(isRequestRestatement(text), text).toBe(true);
		}
		for (const text of [
			"Identified need to explain mutex using bathroom door analogy",
			"Calculated protein needs using g/kg body weight",
			"Task management approach for the sprint",
			"Mapping the prompt tokens to embeddings",
		]) {
			expect(isRequestRestatement(text), text).toBe(false);
		}
	});
});

describe("isPlausibleShortText", () => {
	it("rejects empty, over-long, over-wordy, and leaked text (title-parity defaults)", () => {
		expect(isPlausibleShortText("")).toBe(false);
		expect(isPlausibleShortText("   ")).toBe(false);
		expect(isPlausibleShortText("x".repeat(101))).toBe(false);
		expect(isPlausibleShortText(Array(13).fill("w").join(" "))).toBe(false);
		expect(isPlausibleShortText("Let me think about this")).toBe(false);
	});

	it("accepts a normal short line", () => {
		expect(isPlausibleShortText("A Perfectly Fine Title")).toBe(true);
		expect(isPlausibleShortText("x".repeat(100))).toBe(true);
		expect(isPlausibleShortText(Array(12).fill("w").join(" "))).toBe(true);
	});

	it("honors custom bounds and rejectReasoningLeak=false", () => {
		expect(isPlausibleShortText("one two three", { maxWords: 2 })).toBe(false);
		expect(isPlausibleShortText("short", { maxChars: 3 })).toBe(false);
		expect(
			isPlausibleShortText("Let me think about it", {
				rejectReasoningLeak: false,
			}),
		).toBe(true);
	});
});

describe("resolveShortTextLanguage", () => {
	it("prefers an explicit preference over everything else", () => {
		expect(resolveShortTextLanguage("bármi magyar szöveg", "en")).toBe("en");
		expect(resolveShortTextLanguage("a plain english sentence", "hu")).toBe(
			"hu",
		);
	});

	it("honors inline language hints", () => {
		expect(resolveShortTextLanguage("Please answer in English")).toBe("en");
		expect(resolveShortTextLanguage("Summarize in english please")).toBe("en");
		expect(resolveShortTextLanguage("Kérlek válaszolj magyarul")).toBe("hu");
	});

	// Ruling 75: the title, the thought-step status line and the rail headline are
	// the person's, so a request for a piece of writing in another language
	// ("Írj egy e-mailt angolul...") leaves them in the conversation's language.
	it("keeps the conversation's language when the message asks for content in another one", () => {
		expect(
			resolveShortTextLanguage(
				"Írj egy e-mailt angolul a kollégámnak, hogy holnap nem tudok bejönni.",
				"auto",
				"hu",
			),
		).toBe("hu");
		expect(
			resolveShortTextLanguage(
				"Write an email to my colleague in Hungarian saying I can't come in tomorrow.",
				"auto",
				"en",
			),
		).toBe("en");
	});

	it("falls back to language detection", () => {
		expect(resolveShortTextLanguage("Egy magyar mondat és kérdés")).toBe("hu");
		expect(
			resolveShortTextLanguage("A short note about deployment steps"),
		).toBe("en");
	});

	// Title generation's "auto" preference used to fall to raw detectLanguage,
	// which collapses an ambiguous message straight to "en" — ignoring the
	// user's actual uiLanguage. Delegating to language.ts's shared
	// resolveResponseLanguage (2026-09-25 review) fixes that without a second
	// fallback policy living here.
	it("falls back to uiLanguage (via the shared resolver) when the message is ambiguous and no preference pins it", () => {
		expect(resolveShortTextLanguage("ok", undefined, "hu")).toBe("hu");
		expect(resolveShortTextLanguage("ok", "auto", "hu")).toBe("hu");
		expect(resolveShortTextLanguage("ok", "auto", "en")).toBe("en");
	});

	it("still prefers an explicit inline hint or clearly-detected language over uiLanguage", () => {
		expect(
			resolveShortTextLanguage("Kérlek válaszolj magyarul", "auto", "en"),
		).toBe("hu");
		expect(
			resolveShortTextLanguage("Egy magyar mondat és kérdés", "auto", "en"),
		).toBe("hu");
	});

	it("still lets an explicit en/hu preference win over uiLanguage", () => {
		expect(resolveShortTextLanguage("ok", "en", "hu")).toBe("en");
		expect(resolveShortTextLanguage("ok", "hu", "en")).toBe("hu");
	});

	it("defaults to English when the message is ambiguous and no uiLanguage is given either", () => {
		expect(resolveShortTextLanguage("ok")).toBe("en");
		expect(resolveShortTextLanguage("ok", "auto")).toBe("en");
	});
});

describe("isHungarianText", () => {
	it("detects Hungarian by accented characters", () => {
		expect(isHungarianText("Magyar cím")).toBe(true);
		expect(isHungarianText("Adatbázis tervezési tanácsok")).toBe(true);
	});

	it("detects Hungarian by strong function words without accents", () => {
		expect(isHungarianText("nem van meg")).toBe(true);
	});

	it("treats plain English as non-Hungarian", () => {
		expect(isHungarianText("How to Create React Components")).toBe(false);
		expect(isHungarianText("Practical Database Design Advice")).toBe(false);
	});
});

describe("callShortLocalControlModel", () => {
	beforeEach(() => {
		sendJsonControlMessageMock.mockReset();
		recordControlModelUsageMock.mockClear();
	});

	it("calls the control model and records spend via the shared cost path", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({
				text: '{"intentClass":"chat"}',
				usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
			}),
		);

		const result = await callShortLocalControlModel({
			message: "hello there",
			feature: "unit_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "classify this",
			thinkingMode: "off",
			temperature: 0,
			maxTokens: 150,
			timeoutMs: 800,
		});

		expect(result?.text).toBe('{"intentClass":"chat"}');

		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{ thinkingMode?: string; temperature?: number; signal?: AbortSignal },
		];
		expect(message).toBe("hello there");
		expect(modelId).toBe("model2");
		expect(options.thinkingMode).toBe("off");
		expect(options.temperature).toBe(0);
		expect(options.signal).toBeInstanceOf(AbortSignal);

		expect(recordControlModelUsageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				feature: "unit_feature",
				userId: "u1",
				conversationId: "c1",
				modelId: "model2",
				promptTokens: 40,
				completionTokens: 12,
				totalTokens: 52,
			}),
		);
	});

	it("returns null and records no spend when the control call rejects", async () => {
		sendJsonControlMessageMock.mockRejectedValue(new Error("upstream timeout"));

		const result = await callShortLocalControlModel({
			message: "hello there",
			feature: "unit_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "classify this",
		});

		expect(result).toBeNull();
		expect(recordControlModelUsageMock).not.toHaveBeenCalled();
	});

	it("enforces a hard per-feature concurrency cap without a network attempt", async () => {
		const releases: Array<() => void> = [];
		sendJsonControlMessageMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(() =>
						resolve(controlResult({ text: '{"intentClass":"chat"}' })),
					);
				}),
		);

		const inFlight: Array<Promise<unknown>> = [];
		for (let i = 0; i < 2; i += 1) {
			const before = sendJsonControlMessageMock.mock.calls.length;
			inFlight.push(
				callShortLocalControlModel({
					message: `msg ${i}`,
					feature: "cap_feature",
					userId: "u1",
					conversationId: "c1",
					systemPrompt: "s",
					maxConcurrent: 2,
				}),
			);
			await vi.waitFor(() =>
				expect(sendJsonControlMessageMock.mock.calls.length).toBe(before + 1),
			);
		}

		const beforeOverCap = sendJsonControlMessageMock.mock.calls.length;
		const overCap = await callShortLocalControlModel({
			message: "one too many",
			feature: "cap_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
			maxConcurrent: 2,
		});

		expect(overCap).toBeNull();
		expect(sendJsonControlMessageMock.mock.calls.length).toBe(beforeOverCap);

		for (const release of releases) release();
		await Promise.all(inFlight);
	});

	// A2 hardening — the cap counter's `finally` decrement must free the slot
	// once a call settles, or the feature would permanently wedge after
	// `maxConcurrent` lifetime calls. Two sequential capped calls (each fully
	// settled before the next) both reach the network under a cap of 1, proving
	// the slot is released on completion.
	it("frees a cap slot after the call settles so a later call goes through (cap recovery)", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"intentClass":"chat"}' }),
		);

		const first = await callShortLocalControlModel({
			message: "first",
			feature: "recovery_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
			maxConcurrent: 1,
		});
		expect(first?.text).toBe('{"intentClass":"chat"}');

		// Slot freed in the previous call's `finally` — a second call under the
		// same cap of 1 is admitted, not rejected.
		const second = await callShortLocalControlModel({
			message: "second",
			feature: "recovery_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
			maxConcurrent: 1,
		});
		expect(second?.text).toBe('{"intentClass":"chat"}');
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(2);
	});

	// A2 hardening — `timeoutMs` is OPT-IN. When it (and any caller signal) is
	// omitted, the call must go out with NO abort signal at all, documenting
	// that the default is untimed (the caller owns the timeout decision).
	it("passes no abort signal when timeoutMs and signal are both omitted", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"intentClass":"chat"}' }),
		);

		await callShortLocalControlModel({
			message: "no timeout",
			feature: "untimed_feature",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "s",
		});

		const [, , options] = sendJsonControlMessageMock.mock.calls[0] as [
			string,
			string,
			{ signal?: AbortSignal },
		];
		expect(options.signal).toBeUndefined();
	});
});

describe("unwrapJsonControlText", () => {
	it("extracts the string from a JSON-wrapped control result", () => {
		expect(
			unwrapJsonControlText('{"headline": "FlightLink Dublin Checklist"}'),
		).toBe("FlightLink Dublin Checklist");
		expect(unwrapJsonControlText('{\n  "title": "Buy DD1 First"\n}')).toBe(
			"Buy DD1 First",
		);
		// Prefers a known text key, then the first non-empty string value.
		expect(unwrapJsonControlText('{"foo": "", "bar": "Fallback value"}')).toBe(
			"Fallback value",
		);
	});

	it("peels a ```json fence before parsing", () => {
		expect(
			unwrapJsonControlText('```json\n{"headline": "Fenced Headline"}\n```'),
		).toBe("Fenced Headline");
	});

	it("leaves genuine plain text and non-object JSON untouched", () => {
		expect(unwrapJsonControlText("A Short Headline")).toBe("A Short Headline");
		expect(unwrapJsonControlText("Cost is $5 { per unit }")).toBe(
			"Cost is $5 { per unit }",
		);
		// Malformed JSON object: return the raw text rather than throwing.
		expect(unwrapJsonControlText('{"headline": broken')).toBe(
			'{"headline": broken',
		);
		// A JSON object with no string value: leave it as-is.
		expect(unwrapJsonControlText('{"count": 3}')).toBe('{"count": 3}');
	});
});

describe("unwrapJsonControlText: an object the model filled with its own reasoning", () => {
	it("never takes a reasoning-named value for the answer, and reads a suffixed headline key", () => {
		// Keys seen on the real model when it is handed a free JSON object.
		expect(
			unwrapJsonControlText(
				'{\n  "reasoning": "The assistant provides a simple weekly diet plan including meals for each day and shopping tips.",\n  "headline_hu": "Egyszerű heti étrend"\n}',
			),
		).toBe("Egyszerű heti étrend");
		expect(
			unwrapJsonControlText('{"headline_hu": "Északi erkély növényei"}'),
		).toBe("Északi erkély növényei");
		// An answer under an unusual key is still the answer.
		expect(
			unwrapJsonControlText('{"point": "Irodai ülés és hátfájás kezelése"}'),
		).toBe("Irodai ülés és hátfájás kezelése");
		// Only reasoning in the object: nothing to unwrap, the raw text stays.
		const onlyReasoning =
			'{"thought": "The user wants a short Hungarian headline summarizing the provided text."}';
		expect(unwrapJsonControlText(onlyReasoning)).toBe(onlyReasoning);
	});
});

describe("generateShortLocalText", () => {
	beforeEach(() => {
		sendJsonControlMessageMock.mockReset();
		recordControlModelUsageMock.mockClear();
	});

	it("unwraps a JSON-wrapped control result into plain text", async () => {
		// The transport forces JSON output, so a schemaless call returns
		// `{"headline":"…"}` — the seam must store the headline, not the JSON.
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"headline": "Limerick to Dublin fares"}' }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "Write a short headline.",
			maxTokens: 40,
			cleanup: { maxChars: 100, maxWords: 14 },
		});

		expect(out).toBe("Limerick to Dublin fares");
	});

	it("returns cleaned text and records spend on success", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "  A Short Headline  " }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			systemPrompt: "Write a short headline.",
			maxTokens: 40,
		});

		expect(out).toBe("A Short Headline");

		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{ thinkingMode?: string; maxTokens?: number },
		];
		expect(message).toBe("Summarize this turn");
		expect(modelId).toBe("model2");
		expect(options.thinkingMode).toBe("off");
		expect(options.maxTokens).toBe(40);

		expect(recordControlModelUsageMock).toHaveBeenCalledWith(
			expect.objectContaining({ feature: "rail_summary", modelId: "model2" }),
		);
	});

	it("forwards a requested JSON schema to the control model, and still unwraps the object it returns", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: '{"headline": "Heti étrend"}' }),
		);
		const jsonSchema = {
			name: "rail_headline",
			strict: true,
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["headline"],
				properties: { headline: { type: "string" } },
			},
		};

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			jsonSchema,
		});

		expect(out).toBe("Heti étrend");
		expect(sendJsonControlMessageMock.mock.calls[0]?.[2]).toMatchObject({
			jsonSchema,
		});
	});

	it("returns null for an empty prompt without calling the control model", async () => {
		const out = await generateShortLocalText({
			prompt: "   ",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
		});

		expect(out).toBeNull();
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
	});

	it("keeps the answer when the model re-opens an empty think block (closer dropped by the server)", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "<think>\n\n\n\nLimerick to Dublin fares" }),
		);
		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
		});
		expect(out).toBe("Limerick to Dublin fares");
	});

	it("returns null when the model leaves a reasoning block unclosed", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({
				text: "<think>\nThe user wants a short headline for a reply about fares",
			}),
		);
		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
		});
		expect(out).toBeNull();
	});

	it("returns null when the model leaks its reasoning", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "Let me think about how to phrase this" }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
		});

		expect(out).toBeNull();
	});

	it("returns null for an object that holds only the model's reasoning, in either language", async () => {
		for (const text of [
			'{"thought": "The user wants a short Hungarian headline summarizing the provided text."}',
			'{"thought": "A felhasználó egy heti étrendet kért, és az asszisztens egy konkrét hetitervet vázolt fel."}',
		]) {
			sendJsonControlMessageMock.mockResolvedValue(controlResult({ text }));
			const out = await generateShortLocalText({
				prompt: "Summarize this turn",
				feature: "rail_summary",
				userId: "u1",
				conversationId: "c1",
			});
			expect(out, text).toBeNull();
		}
	});

	it("returns null for a JSON blob the model cut off, instead of storing it as the headline", async () => {
		// Real: 0.6% of 520 rail summaries came back as a truncated tool-call-shaped
		// object that was short enough to pass the length bounds.
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({
				text: '{\n  "name": "Local Qwen",\n  "arguments": {\n    "headline": "Egyszerű heti étrend és bevásárlás"\n  }',
			}),
		);
		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			// the rail summary's own bounds, which the blob fits inside
			cleanup: { maxChars: 100, maxWords: 14 },
		});
		expect(out).toBeNull();
	});

	it("returns null for a Hungarian headline that is the model's reasoning about the request", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({
				text: '{"headline": "A felhasználó magyarul kérdez az étrendről"}',
			}),
		);
		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			language: "hu",
		});
		expect(out).toBeNull();
	});

	it("keeps an ordinary Hungarian headline", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({
				text: '{\n  "headline_hu": "Északi erkély növényei és öntözése"\n}',
			}),
		);
		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			language: "hu",
		});
		expect(out).toBe("Északi erkély növényei és öntözése");
	});

	it("returns null when the text is not in the expected language", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: "Magyar cím" }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			language: "en",
		});

		expect(out).toBeNull();
	});

	// A2 hardening — the `cleanup.normalize` hook runs on the raw model text
	// BEFORE the plausibility/language checks. Proven by a raw output that is
	// implausible as-is (over the char bound) but which `normalize` reshapes
	// into an accepted headline.
	it("applies cleanup.normalize before the plausibility checks", async () => {
		sendJsonControlMessageMock.mockResolvedValue(
			controlResult({ text: `"Quoted Headline" ${"x".repeat(200)}` }),
		);

		const out = await generateShortLocalText({
			prompt: "Summarize this turn",
			feature: "rail_summary",
			userId: "u1",
			conversationId: "c1",
			// Strip the trailing noise + surrounding quotes: without this the raw
			// text is far over the 100-char plausibility bound and would be
			// rejected; with it, a clean short headline survives.
			cleanup: { normalize: (raw) => raw.replace(/^"([^"]+)".*$/s, "$1") },
		});

		expect(out).toBe("Quoted Headline");
	});

	it("returns null on a cap miss without a network attempt", async () => {
		const releases: Array<() => void> = [];
		sendJsonControlMessageMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(() =>
						resolve(controlResult({ text: "Fine Headline Here" })),
					);
				}),
		);

		const inFlight: Array<Promise<unknown>> = [];
		for (let i = 0; i < 2; i += 1) {
			const before = sendJsonControlMessageMock.mock.calls.length;
			inFlight.push(
				generateShortLocalText({
					prompt: `prompt ${i}`,
					feature: "rail_cap",
					userId: "u1",
					conversationId: "c1",
					maxConcurrent: 2,
				}),
			);
			await vi.waitFor(() =>
				expect(sendJsonControlMessageMock.mock.calls.length).toBe(before + 1),
			);
		}

		const before = sendJsonControlMessageMock.mock.calls.length;
		const overCap = await generateShortLocalText({
			prompt: "over the cap",
			feature: "rail_cap",
			userId: "u1",
			conversationId: "c1",
			maxConcurrent: 2,
		});

		expect(overCap).toBeNull();
		expect(sendJsonControlMessageMock.mock.calls.length).toBe(before);

		for (const release of releases) release();
		await Promise.all(inFlight);
	});
});
