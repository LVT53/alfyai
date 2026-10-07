// The canvas suite's one async step (decisions.md rulings 56 and 74): can the
// chat's own Mermaid read the diagrams the model wrote onto a board? The scorer
// (`canvas.ts`) is synchronous and browser-free, so what needs an await happens
// here, once per winning attempt, and is handed to it as `evaluation` — recorded
// beside the response under `fixtures/canvas/evaluations/` so a replay needs
// neither a model nor Mermaid.
//
// What is checked is the grammar: `mermaid.parse` is the first thing the chat's
// `Mermaid.svelte` runs on a source, and a source it refuses is drawn as the
// source and an "unable to draw" note instead of a diagram. It runs in a jsdom
// window because Mermaid reads `document` on import and DOMPurify needs one; no
// browser is started, so a replay and the unit tests stay as light as the
// scorer's other checks. (What the diagram's DRAWN height is, which the panel
// sees and a parser cannot, is measured by the app's own e2e spec.)
import { createRequire } from "node:module";
import { decodeToolPathResponse } from "../tool-path";
import type { SuiteEvaluator } from "../types";

// jsdom ships no types here; loaded the way the app's DAV layer loads it.
const require = createRequire(import.meta.url);

/** What is recorded for one attempt: each distinct diagram source the model sent, and whether Mermaid read it. */
interface CanvasEvaluation {
	diagrams: Array<{ code: string; ok: boolean; error?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every Mermaid source in what the model sent: a block `{ kind: "mermaid", code }`
 * wherever it stands in the arguments (an op's `node.data`, an `update_node`'s
 * `data`, a create's board). A model may send `ops` or `body` as text holding
 * JSON, as the tools accept it, so a string that is JSON is read too.
 */
export function diagramSourcesIn(value: unknown, depth = 0): string[] {
	if (depth > 8) return [];
	if (typeof value === "string") {
		const text = value.trim();
		if (
			(text.startsWith("{") && text.endsWith("}")) ||
			(text.startsWith("[") && text.endsWith("]"))
		) {
			try {
				return diagramSourcesIn(JSON.parse(text), depth + 1);
			} catch {
				return [];
			}
		}
		return [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => diagramSourcesIn(item, depth + 1));
	}
	if (!isRecord(value)) return [];
	const own =
		value.kind === "mermaid" && typeof value.code === "string"
			? [value.code]
			: [];
	// An `update_node` carries only `code`, and says which block in its own op.
	const patch =
		value.op === "update_node" &&
		isRecord(value.data) &&
		typeof value.data.code === "string"
			? [value.data.code]
			: [];
	return [
		...own,
		...patch,
		...Object.values(value).flatMap((item) =>
			diagramSourcesIn(item, depth + 1),
		),
	];
}

type MermaidApi = {
	initialize: (config: Record<string, unknown>) => void;
	parse: (text: string) => Promise<unknown>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

/** Mermaid under a jsdom window, loaded once. The posture is the chat's (`Mermaid.svelte`'s `mermaidConfig`). */
function loadMermaid(): Promise<MermaidApi> {
	mermaidPromise ??= (async () => {
		if (typeof window === "undefined") {
			const { JSDOM } = require("jsdom") as {
				JSDOM: new (
					html: string,
					options?: Record<string, unknown>,
				) => { window: Window & typeof globalThis };
			};
			const dom = new JSDOM("<!doctype html><html><body></body></html>", {
				pretendToBeVisual: true,
			});
			Object.assign(globalThis, {
				window: dom.window,
				document: dom.window.document,
			});
		}
		const mermaid = (await import("mermaid")).default as unknown as MermaidApi;
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			htmlLabels: false,
			flowchart: { htmlLabels: false },
			theme: "default",
		});
		return mermaid;
	})();
	return mermaidPromise;
}

/** The first line of a Mermaid parse error, which says where the grammar stopped. */
function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return (
		text
			.split("\n")
			.find((line) => line.trim() !== "")
			?.trim()
			.slice(0, 160) ?? "the source could not be read"
	);
}

export const evaluateCanvasEval: SuiteEvaluator = async (
	_evalCase,
	attempt,
) => {
	const envelope = decodeToolPathResponse(attempt.response);
	if (!envelope) return null;
	const steps = [
		...(envelope.priorSteps ?? []).map((step) => step.toolCalls),
		envelope.toolCalls,
	];
	const sources = [
		...new Set(
			steps.flat().flatMap((call) => diagramSourcesIn(call.arguments)),
		),
	];
	if (sources.length === 0) return null;
	const mermaid = await loadMermaid();
	const diagrams: CanvasEvaluation["diagrams"] = [];
	for (const code of sources) {
		try {
			await mermaid.parse(code);
			diagrams.push({ code, ok: true });
		} catch (error) {
			diagrams.push({ code, ok: false, error: firstLine(error) });
		}
	}
	return { diagrams } satisfies CanvasEvaluation;
};

/** What the evaluator recorded for one source, or `undefined` when there is no evaluation (a replay without one, a source it did not see). */
export function diagramVerdict(
	evaluation: unknown,
	code: string,
): { ok: boolean; error?: string } | undefined {
	if (!isRecord(evaluation) || !Array.isArray(evaluation.diagrams)) {
		return undefined;
	}
	const found = evaluation.diagrams.find(
		(entry): entry is { code: string; ok: boolean; error?: string } =>
			isRecord(entry) && entry.code === code && typeof entry.ok === "boolean",
	);
	return found ? { ok: found.ok, error: found.error } : undefined;
}
