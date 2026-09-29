import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALFYAI_NEMOTRON_PROMPT } from "$lib/server/prompts";
import { buildArtifactCatalogueBlock } from "$lib/server/services/artifacts/catalogue";
import { runReadArtifactTool } from "$lib/server/services/normal-chat-tools/artifact-tools/read";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { EVAL_CASES } from "../cases";
import { loadCommittedResponseFromDisk, runSuite } from "../run";
import { getSuiteScorer } from "../scoring";
import { encodeToolPathResponse } from "../tool-path";
import type { EvalAttempt, EvalCase } from "../types";
import {
	artifactCatalogueBlockFor,
	CANVAS_EVAL_CASES,
	CANVAS_TOOL_SUITE,
	canvasSystemPrompt,
	frameProblems,
	labelProblems,
	loadFixtureBoard,
	overlapProblems,
	readArtifactAnswer,
	removedProblems,
	scoreCanvasEval,
	userMessage,
} from "./canvas";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");
const ART = "3f6b2a94-7c1e-4d55-9a0e-5b2f1c8d7e10";

function caseOf(id: string): EvalCase {
	const found = CANVAS_EVAL_CASES.find((c) => c.id === id);
	if (!found) throw new Error(`no case ${id}`);
	return found;
}

/** A recorded answer: the model looked at the board, then made this one call. */
function editAnswer(
	ops: unknown,
	overrides: {
		summary?: string;
		artifactId?: string;
		read?: boolean;
		extraCalls?: Array<{ name: string; arguments: unknown }>;
		patches?: unknown;
	} = {},
): string {
	return encodeToolPathResponse({
		toolCalls: [
			{
				name: "edit_artifact",
				arguments: {
					artifactId: overrides.artifactId ?? ART,
					ops,
					summary: overrides.summary ?? "Changed the board",
					...(overrides.patches === undefined
						? {}
						: { patches: overrides.patches }),
				},
			},
			...(overrides.extraCalls ?? []),
		],
		content: "",
		finishReason: "tool_calls",
		...(overrides.read === false
			? {}
			: {
					priorSteps: [
						{
							toolCalls: [
								{ name: "read_artifact", arguments: { artifactId: ART } },
							],
							content: "",
							results: ["(the board)"],
						},
					],
				}),
	});
}

function createAnswer(
	board: unknown,
	overrides: {
		title?: string;
		artifactType?: string;
		body?: unknown;
		extraCalls?: Array<{ name: string; arguments: unknown }>;
	} = {},
): string {
	return encodeToolPathResponse({
		toolCalls: [
			{
				name: "create_artifact",
				arguments: {
					artifactType: overrides.artifactType ?? "canvas",
					title: overrides.title ?? "Weekend in Vienna",
					body: "body" in overrides ? overrides.body : JSON.stringify(board),
				},
			},
			...(overrides.extraCalls ?? []),
		],
		content: "",
		finishReason: "tool_calls",
	});
}

function score(id: string, response: string) {
	const attempt: EvalAttempt = { caseId: id, suite: "canvas", response };
	return scoreCanvasEval(caseOf(id), attempt);
}

const move = (id: string, x: number, y: number) => ({
	op: "move",
	id,
	to: { x, y },
});

const sticky = (
	id: string,
	text: string,
	x: number,
	y: number,
	parentId?: string,
) => ({
	id,
	type: "sticky",
	...(parentId ? { parentId } : {}),
	position: { x, y },
	data: { kind: "sticky", text, tone: "yellow" },
});

const frame = (
	id: string,
	label: string,
	x: number,
	y: number,
	w: number,
	h: number,
) => ({
	id,
	type: "frame",
	position: { x, y },
	data: { kind: "frame", label, width: w, height: h },
});

/** What a careful model would send for each edit case. */
const HONEST_EDITS: Record<string, unknown[]> = {
	"canvas-arrange-saturday": [
		move("breakfast", 20, 56),
		move("museum", 230, 56),
		move("lunch", 20, 152),
		move("walk", 230, 152),
		move("opera", 20, 248),
	],
	"canvas-add-sunday": [
		{
			op: "add_frame",
			id: "sun",
			label: "Sunday",
			position: { x: 40, y: 440 },
			size: { width: 300, height: 330 },
		},
		...[
			["brunch", "Brunch, 10:00", 50],
			["prater", "Walk in the Prater", 144],
			["train", "Train home, 17:30", 238],
		].map(([id, text, y]) => ({
			op: "add_node",
			node: sticky(String(id), String(text), 20, Number(y), "sun"),
		})),
	],
	"canvas-remove-and-connect": [
		{ op: "remove_node", id: "museum" },
		{ op: "add_edge", edge: { id: "e3", source: "lunch", target: "walk" } },
	],
	"canvas-add-sunday-hu": [
		{
			op: "add_frame",
			id: "sun",
			label: "Vasárnap",
			position: { x: 40, y: 440 },
			size: { width: 300, height: 330 },
		},
		...[
			["brunch", "Brunch 10:00-kor", 50],
			["prater", "Séta a Práterben", 144],
			["train", "Vonat haza 17:30-kor", 238],
		].map(([id, text, y]) => ({
			op: "add_node",
			node: sticky(String(id), String(text), 20, Number(y), "sun"),
		})),
	],
};

const HONEST_CREATES: Record<string, unknown> = {
	"canvas-create-vienna-en": {
		nodes: [
			frame("sat", "Saturday", 40, 40, 460, 260),
			sticky("a", "Breakfast at Café Central", 20, 56, "sat"),
			sticky("b", "Kunsthistorisches Museum", 230, 56, "sat"),
			sticky("c", "Lunch at the Naschmarkt", 20, 152, "sat"),
			frame("sun", "Sunday", 40, 340, 460, 170),
			sticky("d", "Brunch and a walk in the Prater", 20, 56, "sun"),
			sticky("e", "Train home", 230, 56, "sun"),
		],
		edges: [{ id: "e1", source: "a", target: "b" }],
	},
	"canvas-create-vienna-hu": {
		nodes: [
			frame("sat", "Szombat", 40, 40, 460, 260),
			sticky("a", "Reggeli a Café Centralban", 20, 56, "sat"),
			sticky("b", "Kunsthistorisches Museum", 230, 56, "sat"),
			sticky("c", "Ebéd a Naschmarkton", 20, 152, "sat"),
			frame("sun", "Vasárnap", 40, 340, 460, 170),
			sticky("d", "Brunch és séta a Práterben", 20, 56, "sun"),
			sticky("e", "Vonat haza", 230, 56, "sun"),
		],
		edges: [],
	},
};

describe("the canvas suite's cases", () => {
	it("has the six fixtures of the brief — arrange, add a frame (en and hu), remove and connect, a create (en and hu) — each declaring its language", () => {
		const real = CANVAS_EVAL_CASES.filter((c) => !c.knownBad);
		expect(real.map((c) => [c.id, c.language])).toEqual([
			["canvas-arrange-saturday", "en"],
			["canvas-add-sunday", "en"],
			["canvas-remove-and-connect", "en"],
			["canvas-add-sunday-hu", "hu"],
			["canvas-create-vienna-en", "en"],
			["canvas-create-vienna-hu", "hu"],
		]);
	});

	it("declares the known-bad cases, each with a distinct prompt", () => {
		const bad = CANVAS_EVAL_CASES.filter((c) => c.knownBad);
		expect(bad.map((c) => c.id)).toEqual([
			"canvas-known-bad-overlap",
			"canvas-known-bad-out-of-frame",
			"canvas-known-bad-invented-op",
			"canvas-known-bad-removes-more",
		]);
		const prompts = new Set(CANVAS_EVAL_CASES.map((c) => c.prompt));
		expect(prompts.size).toBe(CANVAS_EVAL_CASES.length);
	});

	it("is registered in the harness: the case registry and the scorer registry", () => {
		expect(EVAL_CASES.canvas).toBe(CANVAS_EVAL_CASES);
		expect(getSuiteScorer("canvas")).toBe(scoreCanvasEval);
	});

	it("puts a stored board in front of an edit request, and nothing but the request in front of a create", () => {
		expect(caseOf("canvas-arrange-saturday").prompt).toContain(
			"The Saturday notes are piled on top of each other.",
		);
		expect(caseOf("canvas-arrange-saturday").prompt).toContain(ART);
		expect(caseOf("canvas-create-vienna-en").prompt).toBe(
			"Make me a board for planning a weekend in Vienna.",
		);
	});
});

describe("the request a live case sends (ruling 62)", () => {
	it("goes through the tools with auto choice, thinking off, the case's own language and message", () => {
		const evalCase = caseOf("canvas-add-sunday-hu");
		const spec = CANVAS_TOOL_SUITE.requestFor(evalCase);
		expect(spec).toMatchObject({
			language: "hu",
			toolChoice: "auto",
			thinking: "off",
			user: evalCase.prompt,
		});
		expect(spec.system).toBe(canvasSystemPrompt("hu"));
		expect(spec.withoutTools).toEqual([
			"memory_context",
			"use_skill",
			"suggest_instruction",
		]);
	});

	it("answers a lookup with a neutral stub, the artifact tools with the app's own answers, and no other tool at all", () => {
		const answer = CANVAS_TOOL_SUITE.requestFor(caseOf("canvas-add-sunday"))
			.followUp?.answer;
		if (!answer) throw new Error("no follow-up");
		expect(answer("image_search", {})).toMatch(/No images/);
		expect(answer("research_web", {})).toMatch(/failed/);
		// An edit case lets the model edit — and be told what happened — but not make another board.
		expect(JSON.parse(String(answer("edit_artifact", {})))).toMatchObject({
			success: false,
		});
		expect(answer("create_artifact", {})).toBeNull();
		// A tool with no business in a board request is the step that is scored.
		expect(answer("produce_file", {})).toBeNull();
		expect(answer("email", {})).toBeNull();
		expect(answer("calendar", {})).toBeNull();
		// A place lookup and a spacing check are answered, and the model goes on.
		expect(answer("map_route", {})).toMatch(/No place or route/);
		expect(answer("run_python", {})).toMatch(/could not be run/);
	});

	it("answers the model's read of the board with the real payload, and an id it does not have with the not-found answer", () => {
		const answer = CANVAS_TOOL_SUITE.requestFor(caseOf("canvas-add-sunday"))
			.followUp?.answer;
		if (!answer) throw new Error("no follow-up");
		const read = JSON.parse(
			String(answer("read_artifact", { artifactId: ART })),
		);
		expect(read).toMatchObject({
			success: true,
			artifactType: "canvas",
			artifactId: ART,
		});
		expect(read.blocks.map((b: { id: string }) => b.id)).toContain("lunch");
		expect(typeof read.body).toBe("string");
		const blocksOnly = JSON.parse(
			String(answer("read_artifact", { artifactId: ART, detail: "blocks" })),
		);
		expect(blocksOnly).not.toHaveProperty("body");
		const missing = JSON.parse(
			String(answer("read_artifact", { artifactId: "nope" })),
		);
		expect(missing).toMatchObject({
			success: false,
			candidates: [{ artifactId: ART, title: "Vienna weekend" }],
		});
		// A create case has no board to read yet.
		const createAnswer_ = CANVAS_TOOL_SUITE.requestFor(
			caseOf("canvas-create-vienna-en"),
		).followUp?.answer;
		expect(createAnswer_?.("read_artifact", { artifactId: ART })).toMatch(
			/No item with that id/,
		);
	});

	it("carries the real base system prompt and states the turn's required language", () => {
		expect(canvasSystemPrompt("hu")).toContain(ALFYAI_NEMOTRON_PROMPT);
		expect(canvasSystemPrompt("hu")).toContain(
			"Required response language for this turn: Hungarian.",
		);
		expect(canvasSystemPrompt("en")).toContain(
			"Required response language for this turn: English.",
		);
	});

	it("keeps the language sentence in step with the one production sends", () => {
		const source = readFileSync(
			resolve(HERE, "../../../src/lib/server/services/normal-chat-context.ts"),
			"utf8",
		);
		const label = "$" + "{languageLabel}";
		expect(source).toContain(
			`\`- Required response language for this turn: ${label}.\``,
		);
		expect(source).toContain(
			`\`- Otherwise, you MUST respond in ${label}. This is a hard requirement. Only switch language if the user explicitly asks you to.\``,
		);
		expect(canvasSystemPrompt("en")).toContain(
			"- Otherwise, you MUST respond in English. This is a hard requirement. Only switch language if the user explicitly asks you to.",
		);
	});

	it("keeps the artifact catalogue block in step with the one the app appends to the turn", () => {
		const fixture = {
			artifactId: ART,
			title: "Vienna weekend",
			kind: "edit" as const,
		};
		const real = buildArtifactCatalogueBlock([
			{
				artifactId: fixture.artifactId,
				artifactType: "canvas",
				title: fixture.title,
				updatedAt: Date.now() - 2 * 60_000,
			},
		]);
		expect(
			artifactCatalogueBlockFor({
				...fixture,
				id: "x",
				description: "",
				language: "en",
				request: "",
			}),
		).toBe(real);
		expect(
			userMessage({
				...fixture,
				id: "x",
				description: "",
				language: "en",
				request: "Hi",
			}),
		).toBe(`Hi\n\n## Turn Guidance\n${real}`);
	});

	// The payload the model is handed for a read is the one the tool answers with:
	// same board, same shaping — compared, not assumed.
	it("hands the model exactly the payload the real read_artifact tool answers with for the same board", async () => {
		const { db } = await import("$lib/server/db");
		const { conversations, users } = await import("$lib/server/db/schema");
		const { createArtifact } = await import("$lib/server/services/artifacts");
		const { boardJson } = await import("$lib/shared/artifacts/canvas-body");
		const NOW = new Date("2026-09-29T12:00:00.000Z");
		const userId = `user-${ART}`;
		const conversationId = `conv-${ART}`;
		db.insert(users)
			.values({
				id: userId,
				email: "a@example.com",
				passwordHash: "h",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(conversations)
			.values({
				id: conversationId,
				userId,
				title: "T",
				memoryIncognito: false,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		const board = loadFixtureBoard("vienna-tidy");
		const made = await createArtifact({
			userId,
			conversationId,
			id: ART,
			kind: "canvas",
			title: "Vienna weekend",
			body: boardJson(board),
			author: "user",
		});
		if (!made.ok) throw new Error("setup");
		const fixture = JSON.parse(
			readFileSync(join(FIXTURES_ROOT, "canvas", "add-sunday.json"), "utf8"),
		);
		for (const detail of ["blocks", "full"] as const) {
			const real = await runReadArtifactTool({
				userId,
				conversationId,
				artifactId: ART,
				detail,
				abortSignal: new AbortController().signal,
			});
			const { compactModelPayload } = await import(
				"$lib/server/services/normal-chat-tools/shared"
			);
			expect(readArtifactAnswer(fixture, { artifactId: ART, detail })).toBe(
				JSON.stringify(compactModelPayload(real.modelPayload)),
			);
		}
	});
});

describe("scoring — an edit a careful model would make", () => {
	it.each(
		Object.keys(HONEST_EDITS),
	)("scores the honest answer good: %s", (id) => {
		const result = score(id, editAnswer(HONEST_EDITS[id]));
		expect(result.reasons, id).toEqual([expect.stringMatching(/^ok:/)]);
		expect(result.verdict).toBe("good");
	});

	it("says what it checked, and that the model read the board first", () => {
		const result = score(
			"canvas-remove-and-connect",
			editAnswer(HONEST_EDITS["canvas-remove-and-connect"]),
		);
		expect(result.reasons[0]).toMatch(/2 ops applied in 1 edit call, .*nodes/);
	});
});

describe("scoring — the tool call itself", () => {
	it("fails an answer that is not a recorded tool-call envelope", () => {
		expect(score("canvas-add-sunday", "not json").reasons[0]).toMatch(
			/^tool-call:/,
		);
	});

	it("fails an edit that never came, naming what the last step was", () => {
		const response = encodeToolPathResponse({
			toolCalls: [{ name: "create_artifact", arguments: {} }],
			content: "",
			finishReason: "tool_calls",
		});
		const result = score("canvas-add-sunday", response);
		expect(result.verdict).toBe("bad");
		expect(result.reasons[0]).toMatch(
			/^routing:.*create_artifact.*not edit_artifact/,
		);
		const none = score(
			"canvas-add-sunday",
			encodeToolPathResponse({
				toolCalls: [],
				content: "Done!",
				finishReason: "stop",
			}),
		);
		expect(none.reasons[0]).toMatch(
			/^routing:.*no tool was called.*answered in text/,
		);
	});

	it("fails an edit of another id, patches for a board, and ops that are not an array", () => {
		expect(
			score(
				"canvas-remove-and-connect",
				editAnswer(HONEST_EDITS["canvas-remove-and-connect"], {
					artifactId: "other",
				}),
			).reasons.join(" "),
		).toMatch(/tool-args: edit_artifact named "other"/);
		expect(
			score(
				"canvas-remove-and-connect",
				editAnswer(HONEST_EDITS["canvas-remove-and-connect"], {
					patches: [{}],
				}),
			).reasons.join(" "),
		).toMatch(/schema: patches and ops were sent together/);
		expect(
			score("canvas-remove-and-connect", editAnswer("[]")).reasons[0],
		).toMatch(/^tool-args: ops must be an array.*a string/);
	});

	it("fails a create case answered with an edit, and a create for another kind or without a title or a string body", () => {
		const edit = score(
			"canvas-create-vienna-en",
			editAnswer(HONEST_EDITS["canvas-remove-and-connect"]),
		);
		expect(edit.verdict).toBe("bad");
		expect(edit.reasons.join(" ")).toMatch(/tool-args: edit_artifact named/);
		expect(edit.reasons.join(" ")).toMatch(
			/routing: .*the last step was edit_artifact, not create_artifact/,
		);
		expect(
			score(
				"canvas-create-vienna-en",
				createAnswer({}, { artifactType: "document" }),
			).reasons[0],
		).toMatch(/routing:.*"document", not canvas/);
		expect(
			score("canvas-create-vienna-en", createAnswer({}, { title: " " }))
				.reasons[0],
		).toMatch(/^tool-args: title is missing/);
		expect(
			score(
				"canvas-create-vienna-en",
				createAnswer({}, { body: { nodes: [] } }),
			).reasons[0],
		).toMatch(/^tool-args: body must be the board as a JSON string.*an object/);
	});
});

describe("scoring — the rubric on the board an edit leaves", () => {
	const honest = HONEST_EDITS["canvas-arrange-saturday"];

	it("fails an op the vocabulary does not have, naming the path", () => {
		const result = score(
			"canvas-remove-and-connect",
			editAnswer([{ op: "delete_node", id: "museum" }]),
		);
		expect(result.verdict).toBe("bad");
		expect(result.reasons[0]).toMatch(/^schema: ops\[0\]\.op/);
	});

	it("fails refused ops — an id that is not on the board — and names the refusal", () => {
		const result = score(
			"canvas-remove-and-connect",
			editAnswer([
				{ op: "remove_node", id: "museum" },
				{
					op: "add_edge",
					edge: { id: "e3", source: "lunch", target: "dinner" },
				},
			]),
		);
		expect(result.verdict).toBe("bad");
		expect(result.reasons.join(" ")).toMatch(
			/refusal: 1 of 2 ops were refused.*unknown_id/,
		);
		// And what the request asked for that then did not happen is found too.
		expect(result.reasons.join(" ")).toMatch(
			/request: no edge connects lunch to the walk/,
		);
	});

	it("fails a diff that leaves two notes piled up, and one that moves a note out of its frame", () => {
		const piled = [...honest.slice(0, 4), move("opera", 40, 170)];
		expect(
			score("canvas-arrange-saturday", editAnswer(piled)).reasons.join(" "),
		).toMatch(
			/overlap: .*"opera" covers sticky "lunch"|overlap: .*lunch.*opera/,
		);
		const out = [...honest.slice(0, 4), move("opera", 20, 300)];
		expect(
			score("canvas-arrange-saturday", editAnswer(out)).reasons.join(" "),
		).toMatch(
			/frames: sticky "opera" at \(20, 300\) sticks out of frame "sat"/,
		);
	});

	it("fails an arrangement that left most of the pile where it was", () => {
		const result = score(
			"canvas-arrange-saturday",
			editAnswer([move("breakfast", 20, 56)]),
		);
		expect(result.verdict).toBe("bad");
		expect(result.reasons.join(" ")).toMatch(/request: .*stayed where it was/);
	});

	it("fails removing what the request did not name, and its edges going with something it did not name", () => {
		const result = score(
			"canvas-remove-and-connect",
			editAnswer([
				{ op: "remove_node", id: "museum" },
				{ op: "remove_node", id: "breakfast" },
				{ op: "add_edge", edge: { id: "e3", source: "lunch", target: "walk" } },
			]),
		);
		expect(result.reasons.join(" ")).toMatch(
			/removed: the request did not name "breakfast"/,
		);
	});

	it("fails a request left undone: the museum still there, no arrow", () => {
		const result = score(
			"canvas-remove-and-connect",
			editAnswer([{ op: "move", id: "museum", to: { x: 230, y: 56 } }]),
		);
		expect(result.reasons.join(" ")).toMatch(
			/request: the museum note is still on the board/,
		);
		expect(result.reasons.join(" ")).toMatch(
			/request: no edge connects lunch to the walk/,
		);
	});

	it("fails a Sunday frame with too few notes, or none, and a note that is not one of the three", () => {
		const two = HONEST_EDITS["canvas-add-sunday"].slice(0, 3);
		expect(
			score("canvas-add-sunday", editAnswer(two)).reasons.join(" "),
		).toMatch(
			/request: 2 new sticky note\(s\) sit inside the Sunday frame, three were asked for/,
		);
		const none = HONEST_EDITS["canvas-add-sunday"].slice(0, 1);
		expect(
			score("canvas-add-sunday", editAnswer(none)).reasons.join(" "),
		).toMatch(/request: 0 new sticky/);
		expect(
			score(
				"canvas-add-sunday",
				editAnswer([{ op: "move", id: "title", to: { x: 600, y: 60 } }]),
			).reasons.join(" "),
		).toMatch(/request: no new frame is labelled for Sunday/);
	});

	it("fails a Sunday frame that sits on the Saturday one, and notes that overflow their frame", () => {
		const onSaturday = HONEST_EDITS["canvas-add-sunday"].map((op) =>
			(op as { op: string }).op === "add_frame"
				? { ...(op as object), position: { x: 60, y: 60 } }
				: op,
		);
		expect(
			score("canvas-add-sunday", editAnswer(onSaturday)).reasons.join(" "),
		).toMatch(
			/overlap: .*frame "sun" covers frame "sat"|overlap: .*"sat".*"sun"/,
		);
		const small = HONEST_EDITS["canvas-add-sunday"].map((op) =>
			(op as { op: string }).op === "add_frame"
				? { ...(op as object), size: { width: 300, height: 150 } }
				: op,
		);
		expect(
			score("canvas-add-sunday", editAnswer(small)).reasons.join(" "),
		).toMatch(/frames: .*sticks out of frame "sun"/);
	});

	it("fails a note with no words", () => {
		const blank = HONEST_EDITS["canvas-add-sunday"].map((op) => {
			const node = (op as { node?: { id: string; data: object } }).node;
			return node?.id === "train"
				? {
						...(op as object),
						node: {
							...node,
							data: { kind: "sticky", text: " ", tone: "yellow" },
						},
					}
				: op;
		});
		expect(
			score("canvas-add-sunday", editAnswer(blank)).reasons.join(" "),
		).toMatch(/labels: sticky "train" has no text/);
	});

	it("reads the fixture's declared language, not the detector's opinion of the request", () => {
		const english = HONEST_EDITS["canvas-add-sunday"].map((op) => op);
		const result = score("canvas-add-sunday-hu", editAnswer(english));
		expect(result.reasons.join(" ")).toMatch(
			/language: the board's new words read as en, but the request declares hu/,
		);
	});

	it("notes, without failing, an edit made without reading, and an arrow the wrong way round", () => {
		expect(
			score(
				"canvas-remove-and-connect",
				editAnswer(HONEST_EDITS["canvas-remove-and-connect"], { read: false }),
			).reasons,
		).toEqual(["note: the board was edited without reading it first"]);
		const reversed = score(
			"canvas-remove-and-connect",
			editAnswer([
				{ op: "remove_node", id: "museum" },
				{ op: "add_edge", edge: { id: "e3", source: "walk", target: "lunch" } },
			]),
		);
		expect(reversed.verdict).toBe("acceptable");
		expect(reversed.reasons[0]).toMatch(/points from the walk to lunch/);
	});

	it("counts a second call that is refused as a miss, even when the first landed — every call is judged by the tools", () => {
		const twice = editAnswer(HONEST_EDITS["canvas-remove-and-connect"], {
			extraCalls: [
				{
					name: "edit_artifact",
					arguments: { artifactId: ART, ops: [move("museum", 1, 1)] },
				},
			],
		});
		const result = score("canvas-remove-and-connect", twice);
		expect(result.verdict).toBe("bad");
		expect(result.reasons.join(" ")).toMatch(
			/refusal: 1 of 1 ops were refused.*unknown_id/,
		);
	});

	it("notes, without failing, an arrangement that is not in the order of the day", () => {
		const jumbled = [
			move("breakfast", 20, 56),
			move("museum", 230, 152),
			move("lunch", 20, 152),
			move("walk", 230, 56),
			move("opera", 20, 248),
		];
		const result = score("canvas-arrange-saturday", editAnswer(jumbled));
		expect(result.verdict).toBe("acceptable");
		expect(result.reasons).toEqual([
			"note: the notes are not in the order of the day",
		]);
	});
});

describe("scoring — a board made through create_artifact", () => {
	it.each(
		Object.keys(HONEST_CREATES),
	)("scores an honest board good: %s", (id) => {
		const result = score(id, createAnswer(HONEST_CREATES[id]));
		expect(result.reasons, id).toEqual([
			expect.stringMatching(/^ok: a board of 7 nodes/),
		]);
	});

	it("fails a body that is not JSON, the way the model's escaping can go wrong, and one the tool would refuse, naming the fix", () => {
		const notJson = score(
			"canvas-create-vienna-en",
			createAnswer(null, { body: '{"nodes": [' }),
		);
		expect(notJson.verdict).toBe("bad");
		expect(notJson.reasons[0]).toMatch(/^schema: The body is not valid JSON/);
		const map = score(
			"canvas-create-vienna-en",
			createAnswer({
				nodes: [
					{
						id: "m",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "map" },
					},
				],
			}),
		);
		expect(map.reasons.join(" ")).toMatch(
			/schema: nodes\[0\] "m": "map" is not a block you can add/,
		);
	});

	it("fails a board with no frame, or too little on it, and notes are judged too: overlap, frames, language", () => {
		const flat = score(
			"canvas-create-vienna-en",
			createAnswer({ nodes: [sticky("a", "Museum", 0, 0)], edges: [] }),
		);
		expect(flat.reasons.join(" ")).toMatch(/request: the board has no frame/);
		expect(flat.reasons.join(" ")).toMatch(/request: 1 block\(s\) with words/);

		const piled = HONEST_CREATES["canvas-create-vienna-en"] as {
			nodes: Array<{ id: string; position: object }>;
		};
		const overlapped = {
			...piled,
			nodes: piled.nodes.map((n) =>
				n.id === "b" ? { ...n, position: { x: 30, y: 60 } } : n,
			),
		};
		expect(
			score("canvas-create-vienna-en", createAnswer(overlapped)).reasons.join(
				" ",
			),
		).toMatch(/overlap:/);

		const wrongLanguage = score(
			"canvas-create-vienna-hu",
			createAnswer(HONEST_CREATES["canvas-create-vienna-en"]),
		);
		expect(wrongLanguage.reasons.join(" ")).toMatch(
			/language: .*read as en, but the request declares hu/,
		);
	});

	it("notes a second create_artifact call in the same conversation", () => {
		const board = HONEST_CREATES["canvas-create-vienna-en"];
		const result = score(
			"canvas-create-vienna-en",
			createAnswer(board, {
				extraCalls: [
					{
						name: "create_artifact",
						arguments: {
							artifactType: "canvas",
							title: "Weekend in Vienna",
							body: JSON.stringify(board),
						},
					},
				],
			}),
		);
		expect(result.verdict).toBe("acceptable");
		expect(result.reasons[0]).toMatch(/note: 2 create_artifact calls/);
	});
});

describe("the rubric's own geometry", () => {
	function board(nodes: unknown[]): CanvasBody {
		return {
			version: 1,
			nodes,
			edges: [],
			viewport: { x: 0, y: 0, zoom: 1 },
			annotations: [],
		} as CanvasBody;
	}

	it("counts a shared pixel of both axes as overlapping, and touching or a frame with its own child as not", () => {
		expect(
			overlapProblems(
				board([sticky("a", "a", 0, 0), sticky("b", "b", 100, 40)]),
			),
		).toHaveLength(1);
		// Side by side, exactly touching: 190 wide.
		expect(
			overlapProblems(
				board([sticky("a", "a", 0, 0), sticky("b", "b", 190, 0)]),
			),
		).toEqual([]);
		expect(
			overlapProblems(
				board([frame("f", "F", 0, 0, 300, 200), sticky("a", "a", 10, 10, "f")]),
			),
		).toEqual([]);
	});

	it("reads a note in a frame in board coordinates: two frames' children can share coordinates and not space", () => {
		expect(
			overlapProblems(
				board([
					frame("f", "F", 0, 0, 300, 200),
					frame("g", "G", 400, 0, 300, 200),
					sticky("a", "a", 10, 10, "f"),
					sticky("b", "b", 10, 10, "g"),
				]),
			),
		).toEqual([]);
	});

	it("only looks at pairs a change touched when told which", () => {
		const b = board([
			sticky("a", "a", 0, 0),
			sticky("b", "b", 20, 20),
			sticky("c", "c", 500, 500),
		]);
		expect(overlapProblems(b)).toHaveLength(1);
		expect(overlapProblems(b, new Set(["c"]))).toEqual([]);
		expect(overlapProblems(b, new Set(["a"]))).toHaveLength(1);
	});

	it("judges a frame's children against the frame's own size", () => {
		expect(
			frameProblems(
				board([
					frame("f", "F", 0, 0, 300, 200),
					sticky("a", "a", 110, 10, "f"),
				]),
			),
		).toEqual([]);
		expect(
			frameProblems(
				board([
					frame("f", "F", 0, 0, 300, 200),
					sticky("a", "a", 120, 10, "f"),
				]),
			),
		).toHaveLength(1);
	});

	it("finds an empty label, and what went from a board that nobody named", () => {
		expect(labelProblems(board([sticky("a", "", 0, 0)]))).toHaveLength(1);
		const before = loadFixtureBoard("vienna-tidy");
		const after = structuredClone(before);
		after.nodes = after.nodes.filter(
			(n) => n.id !== "museum" && n.id !== "title",
		);
		after.edges = after.edges.filter((e) => e.id !== "e1" && e.id !== "e2");
		expect(removedProblems(before, after, ["museum"])).toEqual([
			'the request did not name "title"',
		]);
		after.edges = [];
		const lost = structuredClone(before);
		lost.edges = lost.edges.filter((e) => e.id !== "e1");
		expect(removedProblems(before, lost, [])[0]).toMatch(/edge "e1" went too/);
	});
});

describe("the known-bad answers (ruling 59: hand-written, never a model call)", () => {
	const KNOWN_BAD: Array<[string, string]> = [
		["canvas-known-bad-overlap", "overlap:"],
		["canvas-known-bad-out-of-frame", "frames:"],
		["canvas-known-bad-invented-op", "schema:"],
		["canvas-known-bad-removes-more", "removed:"],
	];

	it.each(
		KNOWN_BAD,
	)("%s is committed, and the scorer fails it for the reason it exists", (id, tag) => {
		const committed = loadCommittedResponseFromDisk(
			FIXTURES_ROOT,
			"canvas",
			id,
		);
		expect(committed).not.toBeNull();
		const result = score(id, committed?.response ?? "");
		expect(result.verdict).toBe("bad");
		expect(result.reasons.some((r) => r.startsWith(tag))).toBe(true);
		// And only for that reason: nothing else is wrong with it.
		expect(
			result.reasons.filter(
				(r) => !r.startsWith(tag) && !r.startsWith("note:"),
			),
		).toEqual([]);
	});

	function deps(
		scoreImpl = (c: EvalCase, a: EvalAttempt) => scoreCanvasEval(c, a),
	) {
		return {
			cases: { canvas: CANVAS_EVAL_CASES },
			client: null,
			loadCommittedResponse: (suite: string, id: string) =>
				loadCommittedResponseFromDisk(FIXTURES_ROOT, suite, id),
			loadCommittedEvaluation: () => null,
			score: scoreImpl,
			evaluate: async () => null,
			log: () => {},
			defaultThinking: "off" as const,
		};
	}

	it("replays the whole committed set with no model and no key, and every real case has its recorded answer", async () => {
		const report = await runSuite(
			"canvas",
			{ replay: true, limit: null, only: null },
			deps(),
		);
		expect(report.knownBadFailedAsExpected).toBe(true);
		expect(report.results.map((r) => r.caseId).sort()).toEqual([
			"canvas-add-sunday",
			"canvas-add-sunday-hu",
			"canvas-arrange-saturday",
			"canvas-create-vienna-en",
			"canvas-create-vienna-hu",
			"canvas-remove-and-connect",
		]);
		for (const result of report.results) {
			expect(result.reasons.join(" "), result.caseId).not.toMatch(
				/no committed response/i,
			);
			expect(["good", "acceptable", "bad"]).toContain(result.verdict);
		}
	});

	it("passes the harness's own gate: runSuite scores nothing real unless every one fails", async () => {
		const report = await runSuite(
			"canvas",
			{ replay: true, limit: null, only: ["canvas-add-sunday"] },
			deps(),
		);
		expect(report.knownBadFailedAsExpected).toBe(true);
		expect(report.knownBadFailures).toEqual([]);

		// A scorer that let one through would refuse to count the real cases.
		const lenient = await runSuite(
			"canvas",
			{ replay: true, limit: null, only: ["canvas-add-sunday"] },
			deps((c, a) =>
				c.id === "canvas-known-bad-overlap"
					? { verdict: "good" as const, reasons: [] }
					: scoreCanvasEval(c, a),
			),
		);
		expect(lenient.knownBadFailedAsExpected).toBe(false);
		expect(lenient.results).toEqual([]);
	});
});
