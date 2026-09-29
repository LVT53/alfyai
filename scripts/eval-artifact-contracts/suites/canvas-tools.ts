// The three artifact tools' Canvas half, as the app answers them, without a
// database (Feature 2 · Artifacts, Slice 3, T10). A live case is a short
// conversation: the model reads a board, edits it, makes one; the app answers
// each call and the model goes on. This is that answering — the SAME functions
// the tools call (`canvasReadBlocks`, `parseCanvasCreateBody`, `runOps` with the
// board vocabulary, `canvasEditOutcome`, `canvasEditFailureMessage`), so what the
// model reads back in an eval is what it reads in the app, and a board it
// changes is changed by the rules that change one there. A test compares each
// answer with the real tool's for the same call.
//
// It does two jobs from one state machine: the live runner asks it for the
// answer to each call (`answer`), and the scorer REPLAYS a recorded conversation
// through a fresh one, so what was scored is what the model would have been told.
// `events` say, per call, what went wrong in it (tagged like the scorer's
// reasons); the scorer adds what is wrong with the board that was left.
import { z } from "zod";
import {
	canvasEditFailureMessage,
	canvasEditOutcome,
	canvasOpsRequiredMessage,
	canvasReadBlocks,
	parseCanvasCreateBody,
} from "$lib/server/services/normal-chat-tools/artifact-tools/canvas-model";
import { jsonArrayArg } from "$lib/server/services/normal-chat-tools/artifact-tools/tool-args";
import { boardOpsVocabulary } from "$lib/shared/artifacts/board-ops";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { runOps } from "$lib/shared/artifacts/ops";

export interface CanvasToolsOptions {
	/** The board a conversation starts with (an edit case), or none (a create case). */
	board: CanvasBody | null;
	/** Its id: the one the artifact catalogue names. */
	artifactId: string;
	title: string;
	/** A create case lets the model make a board; an edit case does not. */
	allowCreate: boolean;
}

/** One call the model made to one of the three tools, and what was wrong with it (nothing, when `lines` is empty). */
interface CanvasToolEvent {
	name: string;
	/** Whether it changed or made the board. */
	wrote: boolean;
	lines: string[];
}

// The tools' own gates, as `create.ts` and `edit.ts` state them (a test keeps
// each message in step with the real schema's).
const createGate = z.object({
	artifactType: z.enum(["document", "app", "canvas"]),
	title: z.string().min(1).max(200),
	body: z.string().min(1),
});
const editGate = z.object({
	artifactId: z.string().min(1),
	patches: jsonArrayArg("patches").min(1).max(40).optional(),
	ops: jsonArrayArg("ops").min(1).max(40).optional(),
	summary: z.string().min(1).max(200).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, length = 240): string {
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** `compactModelPayload` drops an empty list or a missing value before the model reads the answer. */
function compact(payload: Record<string, unknown>): string {
	const kept: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined || (Array.isArray(value) && value.length === 0)) {
			continue;
		}
		kept[key] = value;
	}
	return JSON.stringify(kept);
}

const NOT_FOUND =
	"No item with that id exists in this conversation. Read it first, or use one of the candidates below.";
const READ_NOT_FOUND =
	"No item with that id exists in this conversation. Use one of the candidates below, the artifact catalogue, or read_generated_file for a produced file.";

/** Lines that name where a list of refusals came from, for a reason the scorer prints. */
function refusalLine(
	refused: ReadonlyArray<{
		index: number;
		op: string;
		id?: string;
		reason: string;
		detail: string;
	}>,
	total: number,
): string {
	const shown = refused
		.slice(0, 3)
		.map(
			(item) =>
				`ops[${item.index}] ${item.op} "${item.id ?? ""}" (${item.reason}): ${clip(item.detail, 140)}`,
		);
	const more = refused.length > 3 ? ` (+${refused.length - 3} more)` : "";
	return `refusal: ${refused.length} of ${total} ops were refused — ${shown.join("; ")}${more}`;
}

export function createCanvasTools(options: CanvasToolsOptions) {
	let board: CanvasBody | null = options.board
		? structuredClone(options.board)
		: null;
	let boardId: string | null = board ? options.artifactId : null;
	let title = options.title;
	let version = 1;
	let made = 0;
	let appliedOps = 0;
	const events: CanvasToolEvent[] = [];

	function notFound(message: string): string {
		return compact({
			success: false,
			error: message,
			candidates: boardId ? [{ artifactId: boardId, title }] : [],
		});
	}

	function read(args: unknown): string {
		const id =
			isRecord(args) && typeof args.artifactId === "string"
				? args.artifactId
				: "";
		if (!board || !boardId || id !== boardId) {
			events.push({ name: "read_artifact", wrote: false, lines: [] });
			return notFound(READ_NOT_FOUND);
		}
		const detail =
			isRecord(args) && args.detail === "blocks" ? "blocks" : "full";
		events.push({ name: "read_artifact", wrote: false, lines: [] });
		return compact({
			success: true,
			artifactId: boardId,
			artifactType: "canvas",
			title,
			blocks: canvasReadBlocks(board),
			...(detail === "full" ? { body: boardJson(board) } : {}),
		});
	}

	function create(args: unknown): string | null {
		if (!options.allowCreate) return null;
		const lines: string[] = [];
		const gate = createGate.safeParse(args);
		if (!gate.success) {
			const record = isRecord(args) ? args : {};
			if (
				record.artifactType !== undefined &&
				record.artifactType !== "canvas"
			) {
				// Another kind's handler would run (a Document, an App): not simulated.
				events.push({
					name: "create_artifact",
					wrote: false,
					lines: [
						`routing: create_artifact was called for "${String(record.artifactType)}", not canvas`,
					],
				});
				return null;
			}
			if (typeof record.title !== "string" || record.title.trim() === "") {
				lines.push("tool-args: title is missing (the card needs one)");
			}
			if (typeof record.body !== "string" || record.body === "") {
				lines.push(
					`tool-args: body must be the board as a JSON string; the model sent ${
						record.body === undefined
							? "none"
							: isRecord(record.body)
								? "an object"
								: typeof record.body
					}`,
				);
			}
			if (lines.length === 0)
				lines.push(`tool-args: ${gate.error.issues[0]?.message}`);
			events.push({ name: "create_artifact", wrote: false, lines });
			return JSON.stringify({
				success: false,
				error: gate.error.issues[0]?.message ?? "Invalid input",
			});
		}
		if (gate.data.artifactType !== "canvas") {
			events.push({
				name: "create_artifact",
				wrote: false,
				lines: [
					`routing: create_artifact was called for "${gate.data.artifactType}", not canvas`,
				],
			});
			return null;
		}
		const parsed = parseCanvasCreateBody(gate.data.body);
		if (!parsed.ok) {
			const found = parsed.error
				.split("\n")
				.map((line) => line.replace(/^- /, "").trim())
				.filter(
					(line) =>
						line !== "" &&
						!line.startsWith("Nothing was created") &&
						!line.startsWith("Fix ") &&
						!line.startsWith("A board is ") &&
						!line.startsWith("Blocks you can add"),
				)
				.map((line) => `schema: ${clip(line)}`);
			events.push({
				name: "create_artifact",
				wrote: false,
				lines: found.length > 0 ? found : [`schema: ${clip(parsed.error)}`],
			});
			return JSON.stringify({ success: false, error: parsed.error });
		}
		if (gate.data.title.trim() === "") {
			// The row's own check (`createArtifact`'s `invalid_title`), which the handler answers like this.
			events.push({
				name: "create_artifact",
				wrote: false,
				lines: ["tool-args: title is missing (the card needs one)"],
			});
			return JSON.stringify({
				success: false,
				error: "The board needs a title.",
			});
		}
		made += 1;
		board = parsed.body;
		boardId = `eval-board-${made}`;
		title = gate.data.title;
		version = 1;
		events.push({ name: "create_artifact", wrote: true, lines: [] });
		return compact({
			success: true,
			artifactId: boardId,
			artifactType: "canvas",
			title,
		});
	}

	function edit(args: unknown): string {
		const lines: string[] = [];
		const finish = (wrote: boolean, answer: string): string => {
			events.push({ name: "edit_artifact", wrote, lines });
			return answer;
		};
		const gate = editGate.safeParse(args);
		if (!gate.success || !isRecord(args)) {
			const record = isRecord(args) ? args : {};
			lines.push(
				!isRecord(args)
					? "tool-args: the edit_artifact arguments were not valid JSON"
					: record.ops !== undefined && !Array.isArray(record.ops)
						? `tool-args: ops must be an array of ops; the model sent ${
								typeof record.ops === "string" ? "a string" : typeof record.ops
							}`
						: `tool-args: ${gate.success ? "Invalid input" : gate.error.issues[0]?.message}`,
			);
			return finish(
				false,
				JSON.stringify({
					success: false,
					error: gate.success
						? "Invalid input"
						: (gate.error.issues[0]?.message ?? "Invalid input"),
				}),
			);
		}
		const { artifactId, patches, ops, summary } = gate.data;
		if (patches && ops) {
			lines.push("schema: patches and ops were sent together");
			return finish(
				false,
				JSON.stringify({
					success: false,
					error: "Send patches or ops, never both in the same call.",
				}),
			);
		}
		if (!patches && !ops) {
			lines.push("schema: the edit carried no ops");
			return finish(
				false,
				JSON.stringify({
					success: false,
					error:
						"Send patches (Document/Slides) or ops (Canvas) — this call had neither.",
				}),
			);
		}
		if (!board || !boardId || artifactId !== boardId) {
			lines.push(
				`tool-args: edit_artifact named "${artifactId}", not the board in this chat`,
			);
			return finish(false, notFound(NOT_FOUND));
		}
		if (patches) {
			lines.push("schema: patches were sent for a board; a board takes ops");
			return finish(
				false,
				JSON.stringify({
					success: false,
					error: canvasOpsRequiredMessage(true),
				}),
			);
		}
		const run = runOps(boardOpsVocabulary, board, {
			id: "eval",
			summary: (summary ?? "").trim() || "Alfy's edit",
			ops: ops ?? [],
		});
		if (!run.ok) {
			lines.push(`schema: ${clip(run.detail)}`);
			return finish(
				false,
				JSON.stringify({
					success: false,
					error: canvasEditFailureMessage({
						ok: false,
						status: 400,
						reason: "invalid_diff",
						detail: run.detail,
					}),
				}),
			);
		}
		if (run.refused.length > 0) {
			lines.push(refusalLine(run.refused, ops?.length ?? 0));
		}
		const outcome = canvasEditOutcome(run);
		if (!outcome.ok) {
			return finish(
				false,
				compact({
					success: false,
					error: outcome.error,
					refused: outcome.refused,
				}),
			);
		}
		board = run.doc;
		version += 1;
		appliedOps += outcome.applied;
		return finish(
			true,
			compact({
				success: true,
				artifactId: boardId,
				versionId: `eval-version-${version}`,
				applied: outcome.applied,
				refused: outcome.refused,
			}),
		);
	}

	return {
		/** The app's answer to a call, or `null` for a tool this conversation does not answer (the call that is scored, or one with no business here). */
		answer(name: string, args: unknown): string | null {
			switch (name) {
				case "read_artifact":
					return read(args);
				case "create_artifact":
					return create(args);
				case "edit_artifact":
					return edit(args);
				default:
					return null;
			}
		},
		events,
		board: () => board,
		boardId: () => boardId,
		title: () => title,
		/** How many ops landed, over every edit. */
		appliedOps: () => appliedOps,
		/** How many times a board was made or changed. */
		writes: () => events.filter((event) => event.wrote).length,
	};
}
