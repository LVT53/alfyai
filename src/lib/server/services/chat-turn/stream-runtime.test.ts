import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { describe, expect, it } from "vitest";
import {
	containsTerminalAiSdkUiStreamPayload,
	extractAiSdkUiStreamMetadataData,
} from "$lib/services/ai-sdk-ui-stream-contract";
import {
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
} from "$lib/utils/tool-calls";
import {
	aiSdkUiStreamContractMetadata,
	aiSdkUiStreamContractParts,
	aiSdkUiStreamContractSequence,
	encodeAiSdkUiFixtureFrame,
	encodeAiSdkUiFixtureFrames,
	malformedAiSdkUiStreamFrames,
	oldBrowserSseNamedEndEvent,
	oldBrowserSseNamedTokenEvent,
} from "../../../../../tests/fixtures/ai-sdk-ui-stream-contract";
import {
	createPreparationErrorResponse,
	createServerChunkRuntime,
	createUiMessageStreamDoneFrame,
	decodeUiMessageStreamParts,
	encodeUiMessageStreamPart,
	streamResponseActivityEvent,
} from "./stream";

describe("stream helper retirement", () => {
	it("does not expose retired upstream stream parser helpers through the stream facade", async () => {
		const streamFacade = await readFile(
			join(process.cwd(), "src/lib/server/services/chat-turn/stream.ts"),
			"utf8",
		);

		expect(streamFacade).not.toMatch(
			/\b(parseUpstreamEvents|parseEventBlock|parseJsonBlock|parseSseBlock|parseMaybeJson|extractAssistantChunk|toIncrementalChunk|extractErrorMessage)\b/,
		);
	});
});

// ADR-0025 amendment (E1) — error codes (StreamErrorCode, including tool-call
// failure codes) ride the existing `data-stream-error` / `data-tool-call`
// parts; this slice adds no new AI SDK UI stream part names. Every
// `streamDataPartEvent("data-...", ...)` call site under chat-turn/ is
// scanned and the resulting set of custom `data-*` part names must equal
// this fixed allow-list exactly — any new call site with an unlisted name
// fails this test, forcing a conscious update (and ADR reconsideration)
// instead of a silent new part name slipping onto the wire.
describe("ADR-0025 amendment (E1) — no new AI SDK UI stream part names", () => {
	const KNOWN_DATA_PART_NAMES = new Set([
		"data-normal-chat-output",
		"data-stream-metadata",
		"data-tool-call",
		"data-response-activity",
		"data-stream-error",
		"data-replay-start",
		"data-replay-end",
		"data-waiting",
	]);

	async function collectDataPartNamesUnderChatTurn(): Promise<Set<string>> {
		const chatTurnDir = join(
			process.cwd(),
			"src/lib/server/services/chat-turn",
		);
		const entries = await readdir(chatTurnDir);
		const names = new Set<string>();
		const callPattern = /streamDataPartEvent\(\s*"(data-[^"]+)"/g;

		for (const entry of entries) {
			if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
			const source = await readFile(join(chatTurnDir, entry), "utf8");
			for (const match of source.matchAll(callPattern)) {
				names.add(match[1]);
			}
		}
		return names;
	}

	it("matches the fixed allow-list of custom data-* part names exactly", async () => {
		const foundNames = await collectDataPartNamesUnderChatTurn();
		expect(foundNames).toEqual(KNOWN_DATA_PART_NAMES);
	});

	it("carries the tool-call failure code on the existing data-tool-call part, not a new part type", () => {
		const failedToolEvent = encodeUiMessageStreamPart({
			type: "data-tool-call",
			data: {
				name: "research_web",
				input: {},
				status: "failed",
				metadata: {
					ok: false,
					evidenceReady: false,
					errorCode: "backend_failure",
				},
			},
			transient: true,
		});
		const [decoded] = decodeUiMessageStreamParts(failedToolEvent);
		expect(decoded).not.toBe("[DONE]");
		expect(decoded && decoded !== "[DONE]" ? decoded.type : null).toBe(
			"data-tool-call",
		);
	});
});

describe("AI SDK UI stream contract fixture", () => {
	it("round-trips the allowed fixture grammar through the app-owned server encoder", () => {
		const encodedByServer = aiSdkUiStreamContractSequence.map((payload) =>
			payload === "[DONE]"
				? createUiMessageStreamDoneFrame()
				: encodeUiMessageStreamPart(
						payload as Parameters<typeof encodeUiMessageStreamPart>[0],
					),
		);

		expect(encodedByServer).toEqual(
			encodeAiSdkUiFixtureFrames(aiSdkUiStreamContractSequence),
		);
		expect(decodeUiMessageStreamParts(encodedByServer.join(""))).toEqual(
			aiSdkUiStreamContractSequence,
		);
	});

	it("ignores malformed frames and old Browser SSE named events", () => {
		const decoded = decodeUiMessageStreamParts(
			[
				...malformedAiSdkUiStreamFrames,
				oldBrowserSseNamedTokenEvent,
				oldBrowserSseNamedEndEvent,
				createUiMessageStreamDoneFrame(),
			].join(""),
		);

		expect(decoded).toEqual(["[DONE]"]);
	});

	it("does not decode trailing partial blocks or treat them as terminal", () => {
		const partialTextFrame = encodeAiSdkUiFixtureFrame(
			aiSdkUiStreamContractParts.textDeltaHello,
		).trimEnd();
		const partialFinishFrame = encodeAiSdkUiFixtureFrame(
			aiSdkUiStreamContractParts.finish,
		).trimEnd();

		expect(decodeUiMessageStreamParts(partialTextFrame)).toEqual([]);
		expect(containsTerminalAiSdkUiStreamPayload(partialFinishFrame)).toBe(
			false,
		);
	});

	it("extracts metadata and terminal state through the shared contract", () => {
		const metadataFrame = encodeAiSdkUiFixtureFrame(
			aiSdkUiStreamContractParts.metadata,
		);
		const finishFrame = encodeAiSdkUiFixtureFrame(
			aiSdkUiStreamContractParts.finish,
		);
		const doneFrame = createUiMessageStreamDoneFrame();
		const decoded = decodeUiMessageStreamParts(
			`${metadataFrame}${finishFrame}${doneFrame}`,
		);
		const metadataPayload = decoded.find(
			(payload) =>
				payload !== "[DONE]" && payload.type === "data-stream-metadata",
		);

		expect(
			extractAiSdkUiStreamMetadataData(metadataPayload ?? "[DONE]"),
		).toEqual(aiSdkUiStreamContractMetadata);
		expect(containsTerminalAiSdkUiStreamPayload(metadataFrame)).toBe(false);
		expect(containsTerminalAiSdkUiStreamPayload(finishFrame)).toBe(true);
		expect(containsTerminalAiSdkUiStreamPayload(doneFrame)).toBe(true);
	});

	it("encodes response activity as a transient AI SDK UI data part", () => {
		expect(
			decodeUiMessageStreamParts(
				streamResponseActivityEvent({
					id: "context-ready",
					kind: "context",
					status: "done",
					count: 2,
				}),
			),
		).toEqual([
			{
				type: "data-response-activity",
				data: {
					id: "context-ready",
					kind: "context",
					status: "done",
					count: 2,
				},
				transient: true,
			},
		]);
	});

	// Vision: the line that says the model is reading the message's pictures
	// rides the same part as every other activity (no new part name), with its
	// count and nothing besides the entry's fixed fields.
	it("encodes the viewing_images activity, with its count, on the same transient part", () => {
		expect(
			decodeUiMessageStreamParts(
				streamResponseActivityEvent({
					id: "viewing-images",
					kind: "viewing_images",
					status: "running",
					count: 2,
					occurredAt: 123,
				}),
			),
		).toEqual([
			{
				type: "data-response-activity",
				data: {
					id: "viewing-images",
					kind: "viewing_images",
					status: "running",
					count: 2,
					occurredAt: 123,
				},
				transient: true,
			},
		]);
	});
});

function eventData(chunks: string[], eventName: string): unknown[] {
	return chunks
		.flatMap((chunk) => decodeUiMessageStreamParts(chunk))
		.filter(
			(
				event,
			): event is Exclude<
				ReturnType<typeof decodeUiMessageStreamParts>[number],
				"[DONE]"
			> => event !== "[DONE]" && event.type === eventName,
		)
		.map((event) => ("data" in event ? event.data : event));
}

function tokenTexts(chunks: string[]): string[] {
	return eventData(chunks, "text-delta").map((data) =>
		typeof data === "object" && data !== null && "delta" in data
			? String((data as { delta?: unknown }).delta ?? "")
			: "",
	);
}

function thinkingTexts(chunks: string[]): string[] {
	return eventData(chunks, "reasoning-delta").map((data) =>
		typeof data === "object" && data !== null && "delta" in data
			? String((data as { delta?: unknown }).delta ?? "")
			: "",
	);
}

function toolCallEvents(chunks: string[]): unknown[] {
	return eventData(chunks, "data-tool-call");
}

function responseActivityLabels(chunks: string[]): string[] {
	return eventData(chunks, "data-response-activity").flatMap((data) => {
		if (!data || typeof data !== "object" || !("label" in data)) return [];
		const label = (data as { label?: unknown }).label;
		return typeof label === "string" ? [label] : [];
	});
}

describe("createServerChunkRuntime", () => {
	it("keeps the app-owned encoder compatible with installed AI SDK UI stream framing", async () => {
		const stream = createUIMessageStream({
			execute({ writer }) {
				writer.write({ type: "text-start", id: "answer" });
				writer.write({ type: "text-delta", id: "answer", delta: "Hi" });
				writer.write({
					type: "data-stream-metadata",
					data: { responseTokenCount: 1 },
					transient: true,
				});
				writer.write({ type: "finish", finishReason: "stop" });
			},
		});
		const response = createUIMessageStreamResponse({ stream });
		const body = await response.text();

		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(body).toContain(
			encodeUiMessageStreamPart({ type: "text-start", id: "answer" }),
		);
		expect(body).toContain(
			encodeUiMessageStreamPart({
				type: "text-delta",
				id: "answer",
				delta: "Hi",
			}),
		);
		expect(body).toContain(
			encodeUiMessageStreamPart({
				type: "data-stream-metadata",
				data: { responseTokenCount: 1 },
				transient: true,
			}),
		);
		expect(body).toContain(
			encodeUiMessageStreamPart({
				type: "finish",
				finishReason: "stop",
			}),
		);
		expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	it("does not emit a split DeepSeek response marker before a thinking preamble", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			thinkingBatchMin: 1,
		});

		runtime.emitChunkWithOutputHandling("response Th");
		expect(chunks).toEqual([]);

		runtime.emitChunkWithOutputHandling(
			"e user is asking me to write 500 words about the USA. This is a straightforward content request.\n\n",
		);
		runtime.emitChunkWithOutputHandling(
			"The United States is a large and diverse country.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"The United States is a large and diverse country.",
		);
		expect(thinkingTexts(chunks).join("")).toContain(
			"The user is asking me to write 500 words about the USA.",
		);
		expect(tokenTexts(chunks).join("")).not.toContain("response");
	});

	it("strips a DeepSeek response marker glued to an inline thinking tag", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			thinkingBatchMin: 1,
		});

		runtime.emitChunkWithOutputHandling("response<");
		expect(chunks).toEqual([]);

		runtime.emitChunkWithOutputHandling(
			"think>The model is planning.</think>The visible answer.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("The visible answer.");
		expect(thinkingTexts(chunks).join("")).toBe("The model is planning.");
		expect(tokenTexts(chunks).join("")).not.toContain("response");
	});

	it("does not leak orphan thinking close tags into visible stream output", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("I used the web tool. </thi");
		runtime.emitChunkWithOutputHandling("nk> The visible answer.");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"I used the web tool.  The visible answer.",
		);
		expect(runtime.fullResponse).not.toContain("</think>");
	});

	it("strips leaked web research diagnostics from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Qudelix alternatives");
		runtime.emitChunkWithOutputHandling("Found 8 source(s)");
		runtime.emitChunkWithOutputHandling(
			" and 16 evidence snippet(s)\n\nThe answer starts here.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"Qudelix alternatives\n\nThe answer starts here.",
		);
	});

	it("strips split leading web-search narration before visible answer tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Friss adatokat keresek");
		runtime.emitChunkWithOutputHandling(
			" a vonóhorgos kerékpárszállító szabályairól.",
		);
		runtime.emitChunkWithOutputHandling(
			"1. A szürke rendszám kormányablaknál igényelhető.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"1. A szürke rendszám kormányablaknál igényelhető.",
		);
		expect(runtime.fullResponse).not.toContain("Friss adatokat keresek");
	});

	it("strips split English web-progress narration before visible answer tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			onResponseActivity(entry) {
				chunks.push(streamResponseActivityEvent(entry));
			},
		});

		runtime.emitChunkWithOutputHandling(
			"The first batch of searches didn't return great results - the queries were too broad.",
		);
		runtime.emitChunkWithOutputHandling(
			"Let me run more targeted searches now.Let me try a couple more targeted fetches.",
		);
		runtime.emitChunkWithOutputHandling(
			"Now I have solid data. Let me pull it all together.",
		);
		runtime.emitChunkWithOutputHandling(
			"\n\n## 5-Day vs 7-Day Accommodation\n\nThe answer starts here.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"## 5-Day vs 7-Day Accommodation\n\nThe answer starts here.",
		);
		expect(runtime.fullResponse).not.toContain("Let me");
		expect(runtime.fullResponse).not.toContain("first batch of searches");
		expect(responseActivityLabels(chunks)).toEqual([
			"The first batch of searches didn't return great results - the queries were too broad.",
			"Let me run more targeted searches now.",
			"Let me try a couple more targeted fetches.",
			"Now I have solid data.",
			"Let me pull it all together.",
		]);
	});

	it("strips split standalone Hungarian web-planning narration before visible answer tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Ki");
		runtime.emitChunkWithOutputHandling("ker");
		runtime.emitChunkWithOutputHandling("esem");
		runtime.emitChunkWithOutputHandling(
			" a vonóhorgos kerékpárszállító rendszámtáblával kapcsolatos aktuális magyar szabályokat.",
		);
		runtime.emitChunkWithOutputHandling(
			"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"Ha a vonóhorgos kerékpárszállító eltakarja az autó rendszámát, külön rendszámtáblát kell felszerelni a tartóra.",
		);
		expect(runtime.fullResponse).not.toContain("Kikeresem");
	});

	// A reply that only STARTS like a web-planning narration is not one: it used to
	// be dropped at the end of the reply, which also cost a real reply its last
	// letters ("...is Rome" was saved as "...is Ro"). Only a narration that is
	// complete is taken out (the "a reply is kept whole" tests below).
	it("keeps an unresolved short web-planning prefix at stream flush", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Ki");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("Ki");
		expect(runtime.fullResponse).toBe("Ki");
	});

	it("holds unresolved short web-planning prefixes with trailing whitespace until the reply ends", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Ki\n\n");
		expect(tokenTexts(chunks).join("")).toBe("");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("Ki\n\n");
		expect(runtime.fullResponse).toBe("Ki\n\n");
	});

	it("holds one-character starts of web-planning prefixes until the reply ends", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("K");
		runtime.emitChunkWithOutputHandling("i\n\n");
		expect(tokenTexts(chunks).join("")).toBe("");
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("Ki\n\n");
		expect(runtime.fullResponse).toBe("Ki\n\n");
	});

	it("strips streamed file-production repair narration and pretty-printed document-source JSON", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling(
			"Let me fix the JSON formatting for the document source.\n",
		);
		runtime.emitChunkWithOutputHandling("{\n");
		runtime.emitChunkWithOutputHandling('  "version": 1,\n');
		runtime.emitChunkWithOutputHandling(
			'  "template": "alfyai_standard_report",\n',
		);
		runtime.emitChunkWithOutputHandling('  "title": "Project summary",\n');
		runtime.emitChunkWithOutputHandling('  "blocks": [\n');
		runtime.emitChunkWithOutputHandling(
			'    {"type": "paragraph", "text": "Actionable takeaways from past work in this folder:"},\n',
		);
		runtime.emitChunkWithOutputHandling('    {"type": "list", "items": [\n');
		runtime.emitChunkWithOutputHandling(
			'      "Disk - Schedule recurring docker system prune",\n',
		);
		runtime.emitChunkWithOutputHandling(
			'      "Memory - Keep session snapshots separate"\n',
		);
		runtime.emitChunkWithOutputHandling("    ]}\n");
		runtime.emitChunkWithOutputHandling("  ]\n");
		runtime.emitChunkWithOutputHandling("}\n");
		runtime.emitChunkWithOutputHandling("Your PDF is being generated now.");
		runtime.flushInlineThinkingBuffer();

		const visible = tokenTexts(chunks).join("");
		expect(visible).toBe("Your PDF is being generated now.");
		expect(runtime.fullResponse).toBe("Your PDF is being generated now.");
		expect(visible).not.toContain("Let me fix");
		expect(visible).not.toContain("Actionable takeaways");
		expect(visible).not.toContain("Disk - Schedule");
		expect(visible).not.toContain('"blocks"');
	});

	it("strips leaked raw web research result blocks from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Qudelix alternatives");
		runtime.emitChunkWithOutputHandling("Found 8 source(s)");
		runtime.emitChunkWithOutputHandling(
			[
				" and 16 evidence snippet(s)",
				"1. title: Qudelix product page",
				"url: https://example.com/qudelix",
				"evidence: Raw search snippets are tool output.",
				"Based on the sources, the Qudelix 5K is the direct comparison point.",
			].join("\n"),
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			[
				"Qudelix alternatives",
				"Based on the sources, the Qudelix 5K is the direct comparison point.",
			].join("\n"),
		);
	});

	it("holds and strips split standalone fetched web page dumps", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Anvil Arrow - Star Citizen Wiki\n");
		runtime.emitChunkWithOutputHandling("Toggle search\nSearch\nToggle menu\n");
		runtime.emitChunkWithOutputHandling(
			[
				"Star Citizen Wiki",
				"Navigation",
				"Home Recent changes Random page Special pages Upload file",
				"Vehicles",
				"Gameplay",
				"External",
				"Status page",
				"Contact us",
				"Discord",
				"Twitter",
				"GitHub",
				"Reddit",
				"Anvil Arrow",
				"From the Star Citizen Wiki, the fidelity encyclopedia",
				"404Fidelity neededThis page does not exist currently. Maybe soon?",
				"The article that you're looking for doesn't exist.",
				"Retrieved from ",
				"starcitizen.tools",
				"Privacy policy",
				"About us",
				"Disclaimers",
				"Cookie statement",
				"Status page",
				"GitHub",
				"Patreon",
				"Ko-fi",
			].join("\n"),
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("");
		expect(runtime.fullResponse).toBe("");
	});

	it("strips split bare source reference markers from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("The newer model");
		runtime.emitChunkWithOutputHandling(" 【S");
		runtime.emitChunkWithOutputHandling("5】 was released recently.");
		runtime.emitChunkWithOutputHandling(
			"\n\nSources:\n- [Official release notes](https://example.com/release)",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"The newer model was released recently.\n\nSources:\n- [Official release notes](https://example.com/release)",
		);
		expect(runtime.fullResponse).not.toContain("【S5】");
	});

	it("strips leaked Python REPL transcripts from visible tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("run_python_");
		runtime.emitChunkWithOutputHandling("repl: import subprocess\n");
		runtime.emitChunkWithOutputHandling(
			"Successfully imported modules: ['math', 'pandas']Code execution completed successfully=== DISK OVERVIEW ===\n",
		);
		runtime.emitChunkWithOutputHandling(
			"Filesystem Size Used Avail Use% Mounted on\noverlay 200G 131G 70G 66% /\nnot found\n",
		);
		runtime.emitChunkWithOutputHandling(
			"MISSING: /run/containerd/containerd.sockI see the root filesystem is 66% used.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe(
			"I see the root filesystem is 66% used.",
		);
	});

	it("strips complete Skill Control Envelope blocks from visible stream tokens", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitChunkWithOutputHandling("Question?\n<skill_control");
		runtime.emitChunkWithOutputHandling(
			'_v1>{"version":1,"operations":[{"operationId":"op-1","kind":"session_transition","transition":"awaiting_user"}]}</skill_control_v1>',
		);
		runtime.flushInlineThinkingBuffer();

		expect(tokenTexts(chunks).join("")).toBe("Question?\n");
		expect(runtime.fullResponse).toBe("Question?\n");
		expect(runtime.skillControlEnvelopePayloads).toEqual([
			'{"version":1,"operations":[{"operationId":"op-1","kind":"session_transition","transition":"awaiting_user"}]}',
		]);
	});

	// The real model writes the envelope's JSON on a line of its own. A streamed
	// chunk that started that line with `{"vers…` looked like the start of a
	// leaked produce_file payload (`{"version":1,"blocks"…`) to the leaked-output
	// cleanup, which swallowed the whole object before the envelope was read:
	// the card was lost on some turns and not others, by where a token boundary
	// fell (24 of 32 real drafts lost over three chunkings, 2026-10-25).
	describe("a Skill Control Envelope whose JSON line is split across chunks", () => {
		const envelopeJson =
			'{"version":1,"operations":[{"operationId":"skill-draft-1","kind":"skill_draft","draft":{"id":"weekly-status","displayName":"Weekly status","description":"Writes a short weekly status update.","instructions":"Ask for the period, then write what is done, next and blocked.","activationExamples":["Write my weekly status."],"sourceScope":"current_conversation"}}]}';
		const reply = `Here is the draft.\n\n<skill_control_v1>\n${envelopeJson}\n</skill_control_v1>`;

		function streamInPieces(pieces: string[]) {
			const chunks: string[] = [];
			const runtime = createServerChunkRuntime({
				enqueueChunk(chunk) {
					chunks.push(chunk);
					return true;
				},
			});
			for (const piece of pieces) runtime.emitChunkWithOutputHandling(piece);
			runtime.flushPendingThinking();
			runtime.flushInlineThinkingBuffer();
			runtime.flushOutputBuffer();
			return { runtime, visible: tokenTexts(chunks).join("") };
		}

		it("reads the envelope when a chunk ends inside its opening characters", () => {
			const { runtime, visible } = streamInPieces([
				"Here is the draft.\n\n<skill_control_v1>",
				'\n{"vers',
				envelopeJson.slice('{"vers'.length),
				"\n</skill_control_v1>",
			]);

			expect(runtime.skillControlEnvelopePayloads).toEqual([envelopeJson]);
			expect(visible).toBe("Here is the draft.\n\n");
			expect(runtime.fullResponse).toBe("Here is the draft.\n\n");
		});

		it("reads the same envelope wherever a two-chunk split falls", () => {
			for (let at = 1; at < reply.length; at += 1) {
				const { runtime, visible } = streamInPieces([
					reply.slice(0, at),
					reply.slice(at),
				]);
				expect(runtime.skillControlEnvelopePayloads, `split at ${at}`).toEqual([
					envelopeJson,
				]);
				expect(visible, `split at ${at}`).toBe("Here is the draft.\n\n");
			}
		});

		it("keeps the envelope's words as the model wrote them", () => {
			// "search results:" is leaked-tool text to the cleanup; inside the
			// envelope it is the skill's own instruction.
			const json = envelopeJson.replace(
				"Ask for the period, then write what is done, next and blocked.",
				"Run the search, then summarize the search results: one line per source.",
			);
			const text = `Draft:\n<skill_control_v1>\n${json}\n</skill_control_v1>`;
			const pieces: string[] = [];
			for (let index = 0; index < text.length; index += 5) {
				pieces.push(text.slice(index, index + 5));
			}
			const { runtime, visible } = streamInPieces(pieces);

			expect(runtime.skillControlEnvelopePayloads).toEqual([json]);
			expect(visible).toBe("Draft:\n");
		});

		it("reads an envelope the model left unclosed at the end of its reply", () => {
			const text = `Here is the draft.\n\n<skill_control_v1>\n${envelopeJson}`;
			const pieces: string[] = [];
			for (let index = 0; index < text.length; index += 7) {
				pieces.push(text.slice(index, index + 7));
			}
			const { runtime, visible } = streamInPieces(pieces);

			expect(runtime.skillControlEnvelopePayloads).toEqual([envelopeJson]);
			expect(visible).toBe("Here is the draft.\n\n");
		});

		it("keeps an open tag with no whole JSON object after it visible", () => {
			const { runtime, visible } = streamInPieces([
				"The block starts with <skill_control_v1> and",
				" then the JSON.",
			]);

			expect(runtime.skillControlEnvelopePayloads).toEqual([]);
			expect(visible).toBe(
				"The block starts with <skill_control_v1> and then the JSON.",
			);
		});

		// The envelope is the last thing a drafting reply writes, so a reply cut
		// off at its output limit is most often cut inside it: the half-written
		// block is not the person's to read.
		it("drops an envelope the reply was cut off inside, as a malformed one", () => {
			const cut = '{"version":1,"operations":[{"operationId":"sk';
			const { runtime, visible } = streamInPieces([
				"Here is the draft.\n\n<skill_control_v1>\n",
				cut,
			]);

			expect(runtime.skillControlEnvelopePayloads).toEqual([cut]);
			expect(visible).toBe("Here is the draft.\n\n");
		});

		it("drops an open tag the reply ended right after", () => {
			const { runtime, visible } = streamInPieces([
				"Here is the draft.\n\n<skill_control_v1>\n",
			]);

			expect(runtime.skillControlEnvelopePayloads).toEqual([""]);
			expect(visible).toBe("Here is the draft.\n\n");
		});

		// A tool call flushes the visible text in the middle of a reply; only the
		// end of the reply may settle an envelope that is still open.
		it("keeps an envelope whole across a tool call in the middle of it", () => {
			const chunks: string[] = [];
			const runtime = createServerChunkRuntime({
				enqueueChunk(chunk) {
					chunks.push(chunk);
					return true;
				},
			});
			runtime.emitChunkWithOutputHandling(
				`Draft:\n<skill_control_v1>\n${envelopeJson.slice(0, 40)}`,
			);
			runtime.emitToolCallEvent("research_web", { query: "q" }, "running");
			runtime.emitChunkWithOutputHandling(
				`${envelopeJson.slice(40)}\n</skill_control_v1>`,
			);
			runtime.flushPendingThinking();
			runtime.flushInlineThinkingBuffer();
			runtime.flushOutputBuffer();

			expect(runtime.skillControlEnvelopePayloads).toEqual([envelopeJson]);
			expect(tokenTexts(chunks).join("")).toBe("Draft:\n");
		});

		it("keeps a partial open tag across a tool call", () => {
			const chunks: string[] = [];
			const runtime = createServerChunkRuntime({
				enqueueChunk(chunk) {
					chunks.push(chunk);
					return true;
				},
			});
			runtime.emitChunkWithOutputHandling("Draft:\n<skill_con");
			runtime.emitToolCallEvent("research_web", { query: "q" }, "running");
			runtime.emitChunkWithOutputHandling(
				`trol_v1>\n${envelopeJson}\n</skill_control_v1>`,
			);
			runtime.flushPendingThinking();
			runtime.flushInlineThinkingBuffer();
			runtime.flushOutputBuffer();

			expect(runtime.skillControlEnvelopePayloads).toEqual([envelopeJson]);
			expect(tokenTexts(chunks).join("")).toBe("Draft:\n");
		});

		it("reads the same envelope at every token-sized chunking", () => {
			for (let size = 1; size <= 12; size += 1) {
				const pieces: string[] = [];
				for (let index = 0; index < reply.length; index += size) {
					pieces.push(reply.slice(index, index + size));
				}
				const { runtime, visible } = streamInPieces(pieces);
				expect(runtime.skillControlEnvelopePayloads, `size ${size}`).toEqual([
					envelopeJson,
				]);
				expect(visible, `size ${size}`).toBe("Here is the draft.\n\n");
			}
		});
	});

	// This used to assert the opposite — that a produce_file call was kept OUT
	// of `serverSegments`, because the chat renders its file card from the job
	// read-model and the segment looked like duplicate UI. But `serverSegments`
	// is `messages.toolCalls`, which is what the NEXT turn's native history
	// replays, so the model had no evidence in its own history that it had
	// produced anything: live, it retracted a true statement ("I said 'PDF
	// attached' but never ran the build") and produced the same file a second
	// time. The segment is persisted now; the UI stays unchanged because every
	// segment consumer filters through `isVisibleThinkingToolCall`.
	it("persists file-production tool calls as thinking segments the UI still hides", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"produce_file",
			{ requestTitle: "Report" },
			"running",
		);
		runtime.emitToolCallEvent("produce_file", {}, "done", {
			outputSummary: "File production job job-1 succeeded: report.pdf.",
			resultDigest:
				'Read it back with read_generated_file({filename:"report.pdf"}).',
		});

		expect(toolCallEvents(chunks)).toHaveLength(2);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({ name: "produce_file", status: "done" }),
		]);
		expect(runtime.serverSegments).toEqual([
			expect.objectContaining({
				type: "tool_call",
				name: "produce_file",
				status: "done",
				input: { requestTitle: "Report" },
				outputSummary: "File production job job-1 succeeded: report.pdf.",
				resultDigest:
					'Read it back with read_generated_file({filename:"report.pdf"}).',
			}),
		]);
		// The UI predicate every segment consumer goes through (ThinkingBlock,
		// MessageBubble): a file-production call never renders a tool row, so no
		// duplicate card appears beside the job card.
		expect(runtime.serverSegments.filter(isVisibleThinkingSegment)).toEqual([]);
		expect(runtime.serverSegments.filter(isVisibleThinkingToolCall)).toEqual(
			[],
		);
	});

	it("records prefetched done-only web tool calls with citation candidates", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"research_web",
			{ query: "Open https://example.com/" },
			"done",
			{
				callId: "server-prefetch:web:1",
				sourceType: "web",
				outputSummary:
					"Server-prefetched 1 web source and 2 evidence snippets.",
				candidates: [
					{
						id: "direct:https://example.com/",
						title: "Example Domain",
						url: "https://example.com/",
						snippet: "Example Domain excerpt",
						sourceType: "web",
						material: true,
					},
				],
				metadata: {
					ok: true,
					evidenceReady: true,
					serverPrefetched: true,
				},
			},
		);

		expect(toolCallEvents(chunks)).toHaveLength(1);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({
				callId: "server-prefetch:web:1",
				name: "research_web",
				status: "done",
				sourceType: "web",
				candidates: [
					expect.objectContaining({
						title: "Example Domain",
						url: "https://example.com/",
						sourceType: "web",
					}),
				],
			}),
		]);
		expect(runtime.serverSegments).toEqual([
			expect.objectContaining({
				callId: "server-prefetch:web:1",
				name: "research_web",
				status: "done",
				candidates: [
					expect.objectContaining({
						title: "Example Domain",
						url: "https://example.com/",
					}),
				],
			}),
		]);
	});

	it("coalesces duplicate tool starts by call id and completes that call", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "tool-call-1" },
		);
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "SvelteKit streaming docs" },
			"running",
			{ callId: "tool-call-1" },
		);
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "tool-call-1",
			sourceType: "web",
			outputSummary: "Found sources",
		});

		expect(toolCallEvents(chunks)).toHaveLength(2);
		expect(runtime.toolCallRecords).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
		expect(runtime.serverSegments).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				name: "research_web",
				status: "done",
			}),
		]);
	});

	it("keeps every parallel call of one tool, finishing in any order", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		for (const [callId, prompt] of [
			["call-1", "a beach"],
			["call-2", "a mountain"],
			["call-3", "a forest"],
		]) {
			runtime.emitToolCallEvent("make_image", { prompt }, "running", {
				callId,
			});
		}
		for (const callId of ["call-2", "call-3", "call-1"]) {
			runtime.emitToolCallEvent("make_image", {}, "done", {
				callId,
				outputSummary: `made by ${callId}`,
			});
		}

		expect(toolCallEvents(chunks)).toHaveLength(6);
		expect(runtime.serverSegments).toEqual(
			["call-1", "call-2", "call-3"].map((callId) =>
				expect.objectContaining({
					callId,
					name: "make_image",
					status: "done",
					outputSummary: `made by ${callId}`,
				}),
			),
		);
		expect(runtime.toolCallRecords).toEqual(
			["call-1", "call-2", "call-3"].map((callId) =>
				expect.objectContaining({ callId, status: "done" }),
			),
		);
	});

	it("keeps identical calls apart when their ids differ, at once or in turn", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});
		const input = { prompt: "a birthday card with a fox" };

		runtime.emitToolCallEvent("make_image", input, "running", {
			callId: "call-1",
		});
		runtime.emitToolCallEvent("make_image", input, "running", {
			callId: "call-2",
		});
		runtime.emitToolCallEvent("make_image", {}, "done", { callId: "call-1" });
		runtime.emitToolCallEvent("make_image", {}, "done", { callId: "call-2" });
		runtime.emitToolCallEvent("make_image", input, "running", {
			callId: "call-3",
		});
		runtime.emitToolCallEvent("make_image", {}, "done", { callId: "call-3" });

		expect(runtime.serverSegments).toEqual(
			["call-1", "call-2", "call-3"].map((callId) =>
				expect.objectContaining({ callId, status: "done" }),
			),
		);
	});

	it("still coalesces a repeated start that carries no call id", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});

		runtime.emitToolCallEvent("research_web", { query: "docs" }, "running", {
			callId: "call-1",
		});
		runtime.emitToolCallEvent("research_web", { query: "docs" }, "running");

		expect(runtime.serverSegments).toHaveLength(1);
	});

	it("emits buffered thinking as visible output after 2000 chars when no clear boundary is sent", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			thinkingBatchMin: 1,
		});

		const preamble = "The user is asking me to write about cats. ";
		runtime.emitChunkWithOutputHandling(preamble);
		const longThinking = "a".repeat(2001);
		runtime.emitChunkWithOutputHandling(longThinking);

		expect(tokenTexts(chunks).join("")).toBe(`${preamble}${longThinking}`);
		expect(thinkingTexts(chunks).join("")).toBe("");
	});

	it("does not double-emit buffered text after the 2000-char safety threshold triggers", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
			thinkingBatchMin: 1,
		});

		const preamble = "The user is asking me to write about cats. ";
		runtime.emitChunkWithOutputHandling(preamble);
		const longThinking = "a".repeat(2001);
		runtime.emitChunkWithOutputHandling(longThinking);
		runtime.emitChunkWithOutputHandling("visible answer");
		runtime.flushOutputBuffer();

		const visibleText = tokenTexts(chunks).join("");
		expect(visibleText).toBe(`${preamble}${longThinking}visible answer`);
		expect(visibleText.indexOf(longThinking)).toBe(
			visibleText.lastIndexOf(longThinking),
		);
	});
});

// The owner's live test of "Ask me first" (2026-11-05) lost the answer of two
// replies that had called tools: the saved message held the answer's first
// sentence and nothing else, while the model had written the rest (1,796 output
// tokens in the step that stopped). The cleanup of leaked tool output is written
// for the START of a reply: a narration sentence there ("Let me search...") is
// removed and the raw tool output that follows it is held back until the answer
// begins. The runtime asked it of every buffer, not only the start, so a sentence
// anywhere in the answer that read like a narration ("I found three options on the
// site.") began a hold-back that swallowed the table, the prices and the links
// after it, with no heading or "here is" to end it. The same rule threw away the
// last letters of a reply that ended like the first letters of a narration
// ("...is Rome" saved as "...is Ro").
describe("a reply is kept whole", () => {
	const FIRST =
		"Sunday evening in Limerick with a group and an activity as the anchor.";
	const TABLE = [
		"| Time | Plan | Approx. cost | Link |",
		"|------|------|--------------|------|",
		"| 5:00 pm | Escape room | EUR 22 per person | [Book](https://www.example.ie/escape-limerick) |",
		"| 7:30 pm | Dinner near the Milk Market | EUR 30-45 per person | [Menu](https://www.example.ie/menu) |",
	].join("\n");

	const pieces = (text: string, size: number): string[] =>
		text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];

	// A reply that called a tool first, as the owner's two did: thinking, the
	// call, the result, thinking again, then the answer.
	function streamAfterToolCall(text: string, size: number) {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});
		runtime.emitThinking("Thinking about the plan for the weekend. ".repeat(3));
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "limerick sunday evening" },
			"running",
			{ callId: "call-1" },
		);
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "limerick sunday evening" },
			"done",
			{ callId: "call-1", outputSummary: "10 sources" },
		);
		runtime.emitThinking("Now the plan: a table, prices and links. ".repeat(3));
		for (const piece of pieces(text, size)) {
			runtime.emitChunkWithOutputHandling(piece);
		}
		runtime.flushInlineThinkingBuffer();
		return { saved: runtime.fullResponse, shown: tokenTexts(chunks).join("") };
	}

	// One token at a time, a few at a time, and whole bursts: where the cleanup
	// saw a sentence used to depend on where a chunk ended.
	const chunkSizes = [1, 3, 7, 400, 5000];

	describe.each([
		[
			"a sentence that says it found something",
			"I found three options on the site.",
		],
		[
			"a sentence that says what it will get",
			"I'll get you the full plan below.",
		],
		[
			"a sentence that says it has the details",
			"Now I have the details I need.",
		],
		[
			"a sentence that says it will map out the plan",
			"Let me map out the plan.",
		],
	])("when %s follows the first sentence", (_name, sentence) => {
		it.each(
			chunkSizes,
		)("keeps the table, the prices and the links (chunks of %i characters)", (size) => {
			const answer = [
				FIRST,
				"",
				sentence,
				"",
				TABLE,
				"",
				"Enjoy the weekend!",
			].join("\n");
			const { saved, shown } = streamAfterToolCall(answer, size);
			expect(saved).toBe(answer);
			expect(shown).toBe(answer);
		});
	});

	it.each(
		chunkSizes,
	)("keeps the answer when the narration-like sentence sits in the first paragraph (chunks of %i characters)", (size) => {
		const answer = [`${FIRST} Let me map this out:`, "", TABLE].join("\n");
		const { saved } = streamAfterToolCall(answer, size);
		expect(saved).toBe(answer);
	});

	it.each(
		chunkSizes,
	)("keeps a list of links that arrives with its first sentence (chunks of %i characters)", (size) => {
		const answer = [
			FIRST,
			"",
			"1. Escape room - EUR 22 pp - https://www.example.ie/escape-limerick",
			"2. Dinner at the Milk Market - EUR 30-45 pp - https://www.example.ie/menu",
			"3. Castletroy Park Hotel - EUR 140 a night - https://www.example.ie/castletroy",
			"4. Savoy Hotel Limerick - EUR 120 a night - https://www.example.ie/savoy",
			"5. Bus back to Dublin - EUR 15 - https://www.example.ie/bus",
			"6. Taxi to the station - EUR 12 - https://www.example.ie/taxi",
			"",
			"That is the plan.",
		].join("\n");
		const { saved } = streamAfterToolCall(answer, size);
		expect(saved).toBe(answer);
	});

	it.each([
		["The capital of Italy is Rome"],
		["Thanks for the cake"],
		["Have a nice evening, and see you at the table"],
		["Pay attention to the"],
		["Is it open? No"],
		["That is what I found"],
		["Thanks, tell me"],
	])("keeps the last letters of a reply that ends like a narration begins: %s", (answer) => {
		for (const size of [1, 3, 400]) {
			expect(streamAfterToolCall(answer, size).saved).toBe(answer);
		}
	});

	// The structure of the owner's two lost replies: a sentence, then a tool call,
	// then the answer. The sentence before the call was saved; the whole answer
	// after the call was not (it opened with a sentence that reads like a narration,
	// "Now I have ...", and the cleanup held back everything after it until a line
	// that says "here is" or starts a heading, which a table or a bold line never is).
	const BULLETS = [
		"**Friday**",
		"- 18:00 Check in at the Castletroy Park Hotel - https://www.example.ie/castletroy",
		"- 20:00 Dinner at the Milk Market - https://www.example.ie/menu",
		"**Saturday**",
		"- 10:00 Cliffs of Moher tour - EUR 35 - https://www.example.ie/cliffs",
		"- 19:00 Escape room - EUR 22 - https://www.example.ie/escape",
	].join("\n");

	function streamAcrossToolCall(before: string, after: string, size: number) {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});
		runtime.emitThinking("Thinking about the plan for the weekend. ".repeat(3));
		for (const piece of pieces(before, size)) {
			runtime.emitChunkWithOutputHandling(piece);
		}
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "limerick sunday evening" },
			"running",
			{ callId: "call-1" },
		);
		runtime.emitToolCallEvent(
			"research_web",
			{ query: "limerick sunday evening" },
			"done",
			{ callId: "call-1", outputSummary: "10 sources" },
		);
		runtime.emitThinking("Now the plan: a table, prices and links. ".repeat(3));
		for (const piece of pieces(after, size)) {
			runtime.emitChunkWithOutputHandling(piece);
		}
		runtime.flushInlineThinkingBuffer();
		return { saved: runtime.fullResponse, shown: tokenTexts(chunks).join("") };
	}

	describe.each([
		["Now I have the details I need.", TABLE, "a table"],
		[
			"Now I have all the data I need to put together a plan.",
			BULLETS,
			"bold lines and bullets with links",
		],
		["Let me check the prices.", TABLE, "a table"],
		[
			"I've got the details for all three days.",
			BULLETS,
			"bold lines and bullets with links",
		],
	])("when the answer after a tool call opens with %j", (narration, body, shape) => {
		it.each(
			chunkSizes,
		)(`takes the narration out and keeps ${shape} (chunks of %i characters)`, (size) => {
			const { saved, shown } = streamAcrossToolCall(
				FIRST,
				`${narration}\n\n${body}`,
				size,
			);
			// What matters is the answer. A narration whose first words the stream
			// has already let go of (its verb is not among those held back as it
			// arrives, token by token) stays in front of it; whole, it is taken out.
			expect(saved.startsWith(FIRST)).toBe(true);
			expect(saved.endsWith(body)).toBe(true);
			expect(shown).toBe(saved);
			if (size >= 400) expect(saved).toBe(`${FIRST}${body}`);
		});
	});

	it.each(
		chunkSizes,
	)('keeps the table after "Based on the search results:" in the middle of an answer (chunks of %i characters)', (size) => {
		const answer = [
			"Based on the search results:",
			"",
			TABLE,
			"",
			"Here are the search results: the Savoy is the best value.",
			"",
			"Enjoy the weekend!",
		].join("\n");
		const { saved } = streamAcrossToolCall(
			FIRST,
			`${FIRST}\n\n${answer}`,
			size,
		);
		expect(saved).toBe(`${FIRST}${FIRST}\n\n${answer}`);
	});

	it.each(
		chunkSizes,
	)("lets a tool call end the hold-back a leaked transcript began (chunks of %i characters)", (size) => {
		const after = `${FIRST}\n\n${TABLE}`;
		const { saved } = streamAcrossToolCall(
			"Code execution completed\n",
			after,
			size,
		);
		expect(saved.endsWith(after)).toBe(true);
	});

	it.each(
		chunkSizes,
	)("keeps bold lines and bullets with links after a tool call (chunks of %i characters)", (size) => {
		const answer = `${BULLETS}\n\nEnjoy the weekend!`;
		const { saved } = streamAcrossToolCall(FIRST, answer, size);
		expect(saved).toBe(`${FIRST}${answer}`);
	});

	it("keeps a reply of one word that a narration could start with", () => {
		expect(streamAfterToolCall("No", 1).saved).toBe("No");
		expect(streamAfterToolCall("No", 400).saved).toBe("No");
	});

	it.each([
		["Let me search"],
		["I'll look up the details"],
		["Kikeresem"],
	])("still drops a narration the reply ended in the middle of: %s", (narration) => {
		for (const size of [1, 400]) {
			const { saved, shown } = streamAfterToolCall(narration, size);
			expect(saved).toBe("");
			expect(shown).toBe("");
		}
	});

	it("still takes the narration that opens the text after a tool call out of the answer, though words came before the call", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});
		runtime.emitChunkWithOutputHandling("Here is a first look.");
		runtime.emitToolCallEvent("research_web", { query: "docs" }, "running", {
			callId: "call-1",
		});
		runtime.emitToolCallEvent("research_web", { query: "docs" }, "done", {
			callId: "call-1",
		});
		runtime.emitChunkWithOutputHandling(
			"Now I have solid data. Let me pull it all together.\n\n## The plan\n\nThe answer.",
		);
		runtime.flushInlineThinkingBuffer();

		expect(runtime.fullResponse).toContain("Here is a first look.");
		expect(runtime.fullResponse).toContain("## The plan\n\nThe answer.");
		expect(runtime.fullResponse).not.toContain("Let me pull");
		expect(runtime.fullResponse).not.toContain("solid data");
	});

	it("does not let a narration before a tool call hold back the answer after it", () => {
		const chunks: string[] = [];
		const runtime = createServerChunkRuntime({
			enqueueChunk(chunk) {
				chunks.push(chunk);
				return true;
			},
		});
		runtime.emitChunkWithOutputHandling("Let me search for it.");
		runtime.emitToolCallEvent("research_web", { query: "docs" }, "running", {
			callId: "call-1",
		});
		runtime.emitToolCallEvent("research_web", { query: "docs" }, "done", {
			callId: "call-1",
		});
		const answer = [FIRST, "", TABLE].join("\n");
		for (const piece of pieces(answer, 5)) {
			runtime.emitChunkWithOutputHandling(piece);
		}
		runtime.flushInlineThinkingBuffer();

		expect(runtime.fullResponse).toBe(answer);
	});
});

// Whether the turn has a final answer: visible text on screen after the last tool
// call that needs words after it (`chat-turn/AGENTS.md`, "A Turn's Final Answer").
// The stream terminal reads the fact at a clean end of the model stream.
describe("createServerChunkRuntime: hasTextAfterLastToolCall", () => {
	function runtimeWithNoOutput() {
		return createServerChunkRuntime({
			enqueueChunk() {
				return true;
			},
		});
	}

	function callOf(
		runtime: ReturnType<typeof runtimeWithNoOutput>,
		name: string,
		callId: string,
	) {
		runtime.emitToolCallEvent(name, { q: "x" }, "running", { callId });
		runtime.emitToolCallEvent(name, { q: "x" }, "done", { callId });
	}

	it("counts visible characters, resets for research, and preserves them for delivering tools", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitChunkWithOutputHandling("A B\u200B");
		runtime.flushInlineThinkingBuffer();
		expect(runtime.visibleCharsAfterLastToolCall).toBe(2);
		callOf(runtime, "create_artifact", "deliver");
		expect(runtime.visibleCharsAfterLastToolCall).toBe(2);
		callOf(runtime, "research_web", "research");
		expect(runtime.visibleCharsAfterLastToolCall).toBe(0);
		runtime.emitChunkWithOutputHandling("42.");
		runtime.flushInlineThinkingBuffer();
		expect(runtime.visibleCharsAfterLastToolCall).toBe(3);
	});

	it("counts only diagnostics stripped from visible text across tool calls", () => {
		const runtime = runtimeWithNoOutput();
		const leak = "run_python_repl: import subprocess\n";
		for (const id of ["a", "b"]) {
			runtime.emitChunkWithOutputHandling(leak);
			runtime.flushInlineThinkingBuffer();
			callOf(runtime, "research_web", id);
		}
		expect(runtime.strippedVisibleChars).toBe(
			2 * [...leak].filter((c) => !/\s/.test(c)).length,
		);
		expect(runtime.visibleCharsAfterLastToolCall).toBe(0);
	});

	it("is false at the start", () => {
		expect(runtimeWithNoOutput().hasTextAfterLastToolCall).toBe(false);
	});

	it("is true once visible text is on screen", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitChunkWithOutputHandling("The total is 42.");
		runtime.flushInlineThinkingBuffer();

		expect(runtime.fullResponse).toBe("The total is 42.");
		expect(runtime.hasTextAfterLastToolCall).toBe(true);
	});

	it("is false after a call to a tool that needs words after it, even when words came before", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitChunkWithOutputHandling("I'll calculate the costs.");
		runtime.emitToolCallEvent("run_python", { code: "1+1" }, "running", {
			callId: "call-1",
		});

		// the call flushed the preamble onto the screen, and the call took the fact back
		expect(runtime.fullResponse).toBe("I'll calculate the costs.");
		expect(runtime.hasTextAfterLastToolCall).toBe(false);
		runtime.emitToolCallEvent("run_python", { code: "1+1" }, "done", {
			callId: "call-1",
		});
		expect(runtime.hasTextAfterLastToolCall).toBe(false);
	});

	it("is false after research_web too, and true again once words follow the result", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitChunkWithOutputHandling("Here is a first look.");
		callOf(runtime, "research_web", "call-1");
		expect(runtime.hasTextAfterLastToolCall).toBe(false);

		runtime.emitChunkWithOutputHandling("The answer is 42.");
		runtime.flushInlineThinkingBuffer();
		expect(runtime.hasTextAfterLastToolCall).toBe(true);
	});

	it("is taken back by the last call of several, whichever finishes first", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitToolCallEvent("research_web", { q: "a" }, "running", {
			callId: "call-a",
		});
		runtime.emitToolCallEvent("research_web", { q: "b" }, "running", {
			callId: "call-b",
		});
		runtime.emitToolCallEvent("research_web", { q: "b" }, "done", {
			callId: "call-b",
		});
		// words between the two results are not the answer to the second one
		runtime.emitChunkWithOutputHandling("Half of it is in.");
		runtime.flushInlineThinkingBuffer();
		expect(runtime.hasTextAfterLastToolCall).toBe(true);
		runtime.emitToolCallEvent("research_web", { q: "a" }, "done", {
			callId: "call-a",
		});

		expect(runtime.hasTextAfterLastToolCall).toBe(false);
	});

	it.each([
		"create_artifact",
		"edit_artifact",
		"make_image",
		"suggest_instruction",
		"ask_user",
		"produce_file",
	])("is unchanged by a %s call: true stays true", (toolName) => {
		const runtime = runtimeWithNoOutput();
		runtime.emitChunkWithOutputHandling("Here is the thing you asked for.");
		callOf(runtime, toolName, "call-1");

		expect(runtime.hasTextAfterLastToolCall).toBe(true);
	});

	it.each([
		"create_artifact",
		"edit_artifact",
		"make_image",
		"suggest_instruction",
		"ask_user",
		"produce_file",
	])("is unchanged by a %s call: false stays false", (toolName) => {
		const runtime = runtimeWithNoOutput();
		callOf(runtime, toolName, "call-1");

		expect(runtime.hasTextAfterLastToolCall).toBe(false);
	});

	it("is not set by text the cleanup removes", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitChunkWithOutputHandling("Let me search for it.");
		runtime.flushInlineThinkingBuffer();

		// a narration of the call that is about to be made: the cleanup takes it out
		expect(runtime.fullResponse).toBe("");
		expect(runtime.hasTextAfterLastToolCall).toBe(false);
	});

	it("is not set by whitespace, by zero-width characters, or by reasoning", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitThinking("The user wants the costs. ".repeat(4));
		runtime.emitChunkWithOutputHandling("\n\n");
		runtime.emitChunkWithOutputHandling("\u200B");
		runtime.emitChunkWithOutputHandling("\u200C\u2060 \uFEFF");
		runtime.flushInlineThinkingBuffer();

		// the zero-width characters are on screen, as the model sent them
		expect(runtime.fullResponse).toContain("\u200B");
		expect(runtime.hasTextAfterLastToolCall).toBe(false);

		runtime.emitChunkWithOutputHandling("42");
		runtime.flushInlineThinkingBuffer();
		expect(runtime.hasTextAfterLastToolCall).toBe(true);
	});

	it("is not changed by a repeat of a call it has already seen", () => {
		const runtime = runtimeWithNoOutput();
		runtime.emitToolCallEvent("research_web", { q: "x" }, "running", {
			callId: "call-1",
		});
		runtime.emitToolCallEvent("research_web", { q: "x" }, "done", {
			callId: "call-1",
		});
		runtime.emitChunkWithOutputHandling("The answer is 42.");
		runtime.flushInlineThinkingBuffer();
		// the same call reported again (a prefetched or recovered copy) is ignored
		runtime.emitToolCallEvent("research_web", { q: "x" }, "done", {
			callId: "call-1",
		});

		expect(runtime.hasTextAfterLastToolCall).toBe(true);
	});
});

// The answer to a turn that could not be prepared, for the two routes that prepare
// a stored turn (a retry, and the resume of a reply from an answer): one mapping,
// not one in each route.
describe("createPreparationErrorResponse", () => {
	it("answers a stream-shaped refusal in the shape the stream route's refusals have", async () => {
		const response = createPreparationErrorResponse({
			status: 422,
			error: "Attachment is not ready",
			code: "attachment_not_ready",
			attachmentIds: ["attachment-1"],
			responseShape: "stream-json",
		});

		expect(response.status).toBe(422);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({
			status: 422,
			error: "Attachment is not ready",
			code: "attachment_not_ready",
			attachmentIds: ["attachment-1"],
		});
	});

	it("answers a json-shaped refusal with its code, errorKey and details when it has them", async () => {
		const response = createPreparationErrorResponse({
			status: 409,
			error: "Forked source history requires confirmation",
			code: "forked_source_history_confirmation_required",
			errorKey: "fork.regenerateWarning",
			details: "two forks read this reply",
			responseShape: "json",
		});

		expect(response.status).toBe(409);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({
			error: "Forked source history requires confirmation",
			code: "forked_source_history_confirmation_required",
			errorKey: "fork.regenerateWarning",
			details: "two forks read this reply",
		});
	});

	it("leaves out of a json-shaped refusal what it does not have", async () => {
		const response = createPreparationErrorResponse({
			status: 400,
			error: "conversationId is required",
			responseShape: "json",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "conversationId is required",
		});
	});
});

describe("successful delivery is separate from text", () => {
	it.each([
		{ status: "done" as const, metadata: { ok: true }, delivered: true },
		{ status: "failed" as const, metadata: { ok: true }, delivered: false },
		{ status: "done" as const, metadata: { ok: false }, delivered: false },
		{ status: "done" as const, metadata: { ok: null }, delivered: false },
	])("counts only recorded successful delivery: %j", ({
		status,
		metadata,
		delivered,
	}) => {
		const runtime = createServerChunkRuntime({ enqueueChunk: () => true });
		runtime.emitChunkWithOutputHandling("I'll calculate the costs.");
		runtime.emitToolCallEvent("run_python", {}, "done", {
			callId: "calculation",
		});
		runtime.emitToolCallEvent("create_artifact", {}, status, {
			callId: "delivery",
			metadata,
		});
		expect(runtime.hasDeliveredAnswer).toBe(delivered);
		expect(runtime.hasTextAfterLastToolCall).toBe(false);
		expect(runtime.visibleCharsAfterLastToolCall).toBe(0);
		runtime.emitToolCallEvent("research_web", {}, "running", {
			callId: "later",
		});
		expect(runtime.hasDeliveredAnswer).toBe(false);
	});
});

describe("instruction delivery after research", () => {
	it.each([
		true,
		false,
	])("uses the recorder's offered=%s without an ok field", (offered) => {
		const runtime = createServerChunkRuntime({ enqueueChunk: () => true });
		runtime.emitToolCallEvent("research_web", {}, "done", {
			callId: "research",
		});
		runtime.emitToolCallEvent("suggest_instruction", {}, "done", {
			callId: "offer",
			metadata: { offered },
		});
		expect(runtime.hasDeliveredAnswer).toBe(offered);
		expect(runtime.hasTextAfterLastToolCall).toBe(false);
		expect(runtime.visibleCharsAfterLastToolCall).toBe(0);
	});
});
