// run_python: a scratch code-execution tool for the model, reusing the same
// Docker sandbox execution path as produce_file's program mode
// (sandbox-execution.ts / sandbox/config.ts) — no second sandbox is built
// here. Unlike produce_file, this tool runs synchronously and returns
// stdout/stderr directly to the model instead of producing a downloadable
// file: it exists for scratch arithmetic, unit/date conversions, and quick
// data parsing over text the user gave, not for artifact generation.

import { z } from "zod";
import {
	DISPLAY_OUTPUT_MAX_CHARS,
	DISPLAY_OUTPUT_MAX_LINES,
	type ToolReasonCode,
} from "$lib/shared/tool-reasons";

export const runPythonInputSchema = z.object({
	code: z.string().min(1),
	purpose: z.string().min(1).optional(),
});

export type RunPythonInput = z.infer<typeof runPythonInputSchema>;

export function sanitizeRunPythonInput(input: RunPythonInput): RunPythonInput {
	const purpose = input.purpose?.trim();
	return {
		code: input.code,
		...(purpose ? { purpose } : {}),
	};
}

// Each of stdout/stderr is capped independently at this many characters
// before reaching the model — the sandbox has no output-size guardrail of
// its own for plain stdout/stderr (only for produced files), and a runaway
// print loop must not blow up the prompt.
export const RUN_PYTHON_OUTPUT_CAP_CHARS = 8000;
const TRUNCATION_MARKER = "\n...[truncated]...\n";

// Keep the head AND the tail of an over-long stream: the head usually carries
// the setup/first result, the tail usually carries the final result or the
// traceback — the most useful parts of a long run are disproportionately at
// the ends, not the middle.
function capOutputText(text: string): { text: string; truncated: boolean } {
	if (text.length <= RUN_PYTHON_OUTPUT_CAP_CHARS) {
		return { text, truncated: false };
	}
	const keep = Math.max(
		0,
		RUN_PYTHON_OUTPUT_CAP_CHARS - TRUNCATION_MARKER.length,
	);
	const headLen = Math.ceil(keep / 2);
	const tailLen = Math.floor(keep / 2);
	const head = text.slice(0, headLen);
	const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
	return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}

export interface RunPythonExecutionResult {
	stdout: string;
	stderr: string;
	exitCode?: number;
	error?: string;
}

export interface RunPythonModelPayload {
	success: boolean;
	name: "run_python";
	sourceType: "tool";
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	truncated: boolean;
}

// The sandbox's own 90s exec timeout (see SANDBOX_TIMEOUT_MS) is caught
// inside executeCode and surfaced as this exact error string, with empty
// stdout/stderr and no exitCode — map that into a graceful `timedOut: true`
// result instead of letting a raw "Execution timed out" error reach the
// model as a hard tool failure.
const SANDBOX_TIMEOUT_ERROR = "Execution timed out";

// What the sandbox reports for a run it was told to cancel (also with no exit
// code, so it is read before the missing code is).
const SANDBOX_CANCELLED_ERROR = "Execution cancelled";

// Sentinel for "no exit code was produced" (timeout, or the sandbox failing
// before the process could exit). Not `null`: the tool envelope compacts
// null/undefined values out of the model payload (see compactModelPayload in
// shared.ts), which would silently drop `exitCode` from the timeout case —
// -1 keeps the field present so the model can tell "ran and failed" (a real
// non-zero code) apart from "never produced a code" at a glance.
const NO_EXIT_CODE = -1;

export function buildRunPythonModelPayload(
	execution: RunPythonExecutionResult,
): RunPythonModelPayload {
	const timedOut = execution.error === SANDBOX_TIMEOUT_ERROR;
	const stdoutCapped = capOutputText(execution.stdout ?? "");
	const stderrCapped = capOutputText(execution.stderr ?? "");
	return {
		success: !timedOut && execution.exitCode === 0,
		name: "run_python",
		sourceType: "tool",
		stdout: stdoutCapped.text,
		stderr: stderrCapped.text,
		exitCode: execution.exitCode ?? NO_EXIT_CODE,
		timedOut,
		truncated: stdoutCapped.truncated || stderrCapped.truncated,
	};
}

/**
 * A short copy of what the program printed, for the tool's row: the first
 * DISPLAY_OUTPUT_MAX_LINES lines of the raw stdout, kept to whole lines within
 * DISPLAY_OUTPUT_MAX_CHARS, trailing whitespace trimmed. A first line that is
 * longer than that on its own is cut hard, to one character fewer plus "…".
 * Blank lines before the first printed line are not counted, so a long line
 * behind them is still shown. Null when nothing was printed. It goes on the
 * entry's metadata and is never part of what the model reads.
 */
export function displayOutputOf(stdout: string): string | null {
	const printed = stdout.trimEnd().replace(/^(?:[ \t]*\r?\n)+/, "");
	if (printed === "") return null;

	const lines = printed.split(/\r?\n/).slice(0, DISPLAY_OUTPUT_MAX_LINES);
	const kept: string[] = [];
	let length = 0;
	for (const line of lines) {
		const next = length + (kept.length > 0 ? 1 : 0) + line.length;
		if (next > DISPLAY_OUTPUT_MAX_CHARS) break;
		kept.push(line);
		length = next;
	}
	if (kept.length === 0) {
		// The first line alone is longer than that: its first characters are all
		// there is room for, and they are all in `printed`'s first line.
		return `${printed.slice(0, DISPLAY_OUTPUT_MAX_CHARS - 1)}…`;
	}
	return kept.join("\n").trimEnd();
}

/**
 * The code a run is named with on its row, from the closed list of run_python
 * (`$lib/shared/tool-reasons`), or nothing for a program that ran and exited 0.
 * The sandbox's own time limit and a cancelled run come first; a run that never
 * produced an exit code is the sandbox failing before the program could exit;
 * any other exit code is the program's own error.
 */
export function runPythonReasonOf(
	execution: RunPythonExecutionResult,
	payload: RunPythonModelPayload,
): ToolReasonCode<"run_python"> | undefined {
	if (payload.timedOut) return "timed_out";
	if (execution.error === SANDBOX_CANCELLED_ERROR) return "stopped";
	if (payload.exitCode === NO_EXIT_CODE) return "sandbox_unavailable";
	if (payload.exitCode !== 0) return "program_error";
	return undefined;
}

export function summarizeRunPythonResult(
	payload: RunPythonModelPayload,
): string {
	if (payload.timedOut) {
		return "run_python timed out before completing.";
	}
	const parts = [`exit code ${payload.exitCode}`];
	parts.push(
		`${payload.stdout.length} stdout char${payload.stdout.length === 1 ? "" : "s"}`,
	);
	if (payload.stderr.length > 0) {
		parts.push(
			`${payload.stderr.length} stderr char${payload.stderr.length === 1 ? "" : "s"}`,
		);
	}
	if (payload.truncated) {
		parts.push("output truncated");
	}
	return `run_python finished: ${parts.join(", ")}.`;
}
