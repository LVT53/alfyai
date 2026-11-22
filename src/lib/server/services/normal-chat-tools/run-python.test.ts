import { describe, expect, it } from "vitest";
import {
	DISPLAY_OUTPUT_MAX_CHARS,
	DISPLAY_OUTPUT_MAX_LINES,
} from "$lib/shared/tool-reasons";
import {
	buildRunPythonModelPayload,
	displayOutputOf,
	type RunPythonExecutionResult,
	runPythonReasonOf,
} from "./run-python";

describe("run_python: displayOutputOf, the short copy of what it printed", () => {
	it("keeps the first 12 lines of a longer output", () => {
		const stdout = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);

		const shown = displayOutputOf(stdout);

		expect(DISPLAY_OUTPUT_MAX_LINES).toBe(12);
		expect(shown?.split("\n")).toHaveLength(12);
		expect(shown?.startsWith("line 1\nline 2\n")).toBe(true);
		expect(shown?.endsWith("line 12")).toBe(true);
	});

	it("gives a short output as it was printed, without the newline that ended it", () => {
		expect(displayOutputOf("hi\n")).toBe("hi");
		expect(displayOutputOf("a\nb\nc")).toBe("a\nb\nc");
		// Windows line ends are read as line ends, not kept as stray characters.
		expect(displayOutputOf("a\r\nb\r\n")).toBe("a\nb");
	});

	it("cuts at the last whole line that fits in 600 characters", () => {
		// One hundred characters a line: five lines are 504 characters, six are 605.
		const stdout = Array.from({ length: 10 }, () => "x".repeat(100)).join("\n");

		const shown = displayOutputOf(stdout);

		expect(DISPLAY_OUTPUT_MAX_CHARS).toBe(600);
		expect(shown).toBe(
			Array.from({ length: 5 }, () => "x".repeat(100)).join("\n"),
		);
		expect(shown?.length).toBeLessThanOrEqual(DISPLAY_OUTPUT_MAX_CHARS);
	});

	it("hard-cuts a first line longer than 600 characters to 600, ending in an ellipsis", () => {
		const shown = displayOutputOf("a".repeat(2000));

		expect(shown).toHaveLength(DISPLAY_OUTPUT_MAX_CHARS);
		expect(shown).toBe(`${"a".repeat(DISPLAY_OUTPUT_MAX_CHARS - 1)}…`);
	});

	it("hard-cuts that first line even when more lines follow it", () => {
		expect(displayOutputOf(`${"a".repeat(700)}\nsecond line\n`)).toBe(
			`${"a".repeat(599)}…`,
		);
	});

	it("keeps a first line of exactly 600 characters whole", () => {
		expect(displayOutputOf("b".repeat(600))).toBe("b".repeat(600));
	});

	it("trims trailing whitespace", () => {
		expect(displayOutputOf("hi   \n\n  \t\n")).toBe("hi");
	});

	it("does not start on blank lines, so a long line behind them is still cut and shown", () => {
		expect(displayOutputOf("\n\nresult\n")).toBe("result");
		expect(displayOutputOf(`\n${"c".repeat(700)}`)).toBe(`${"c".repeat(599)}…`);
	});

	it("gives null for no output, and for output that is only whitespace", () => {
		expect(displayOutputOf("")).toBeNull();
		expect(displayOutputOf(" \n\t\n")).toBeNull();
	});
});

describe("run_python: runPythonReasonOf, the code a run is named with", () => {
	const reasonOf = (execution: RunPythonExecutionResult) =>
		runPythonReasonOf(execution, buildRunPythonModelPayload(execution));

	it("is nothing for a program that ran and exited 0", () => {
		expect(
			reasonOf({ stdout: "42\n", stderr: "", exitCode: 0 }),
		).toBeUndefined();
	});

	it("names the sandbox's own time limit timed_out", () => {
		expect(
			reasonOf({ stdout: "", stderr: "", error: "Execution timed out" }),
		).toBe("timed_out");
	});

	it("names a run the sandbox cancelled stopped, though it produced no exit code", () => {
		expect(
			reasonOf({ stdout: "", stderr: "", error: "Execution cancelled" }),
		).toBe("stopped");
	});

	it("names a run that never produced an exit code sandbox_unavailable", () => {
		expect(
			reasonOf({
				stdout: "",
				stderr: "",
				error: "Execution failed: docker daemon unreachable",
			}),
		).toBe("sandbox_unavailable");
		expect(reasonOf({ stdout: "", stderr: "" })).toBe("sandbox_unavailable");
	});

	it("names a program that exited with a code above 0 program_error", () => {
		expect(
			reasonOf({
				stdout: "",
				stderr: "ZeroDivisionError: division by zero",
				exitCode: 1,
				error: "Execution failed with exit code 1",
			}),
		).toBe("program_error");
		expect(reasonOf({ stdout: "", stderr: "", exitCode: 137 })).toBe(
			"program_error",
		);
	});
});
