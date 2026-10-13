import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));

vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: mocks.hasLocalDistillEnabled,
	isCloudModel: mocks.isCloudModel,
	distillConnectorPayload: mocks.distillConnectorPayload,
}));

import {
	applyLocalDistillGate,
	decideLocalDistill,
	decideLocalDistillForPrompt,
} from "./connector-distill";
import {
	createToolCallRecorder,
	executeToolWithEnvelope,
	type ToolCallRecorder,
} from "./shared";

const params = {
	userId: "user-1",
	modelId: "cloud-model",
	capability: "calendar",
	userQuestion: "What is on today?",
	rawText: "09:00 Standup",
};

function distillOn() {
	mocks.hasLocalDistillEnabled.mockResolvedValue(true);
	mocks.isCloudModel.mockResolvedValue(true);
	mocks.distillConnectorPayload.mockResolvedValue({ distilled: "A standup." });
}

/** Runs `inside` the way a tool runs: in the envelope, which is where the mark is written. */
async function inToolCall(
	inside: () => Promise<unknown>,
): Promise<Record<string, unknown> | undefined> {
	const recorder: ToolCallRecorder = createToolCallRecorder();
	await executeToolWithEnvelope({
		toolName: "test_tool",
		timeoutMs: 5_000,
		options: { toolCallId: "call-1", abortSignal: undefined },
		recorder,
		run: async () => {
			await inside();
			return {
				modelPayload: { success: true },
				entry: { name: "test_tool", input: {}, status: "done" as const },
			};
		},
		onError: () => ({
			modelPayload: { success: false },
			entry: { name: "test_tool", input: {}, status: "failed" as const },
		}),
	});
	return recorder.getEntries()[0]?.metadata as
		| Record<string, unknown>
		| undefined;
}

// ADR-0068: a summary a local model wrote after reading a stranger's email is
// not a tool's result, and the mark that says so lives on the tool call. A
// summary asked for with no call to put the mark on used to lose it without a
// word (the mark was a no-op there), so a connector path added outside the
// envelope would have let an address in the summary count as a tool's. It now
// refuses, before the local model reads anything.
describe("decideLocalDistill", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		distillOn();
	});

	it("marks the tool call it runs in", async () => {
		let decision: unknown;
		const metadata = await inToolCall(async () => {
			decision = await decideLocalDistill(params);
		});

		expect(decision).toEqual({ shouldDistill: true, distilled: "A standup." });
		expect(metadata).toMatchObject({ localDistilled: true });
	});

	it("marks nothing when the local model could not summarise", async () => {
		mocks.distillConnectorPayload.mockResolvedValue({ unavailable: true });

		let decision: unknown;
		const metadata = await inToolCall(async () => {
			decision = await decideLocalDistill(params);
		});

		expect(decision).toEqual({ shouldDistill: true, unavailable: true });
		expect(metadata).not.toHaveProperty("localDistilled");
	});

	it("refuses outside a tool call, and the local model is never asked", async () => {
		await expect(decideLocalDistill(params)).rejects.toThrow(
			/outside a tool call/,
		);
		expect(mocks.distillConnectorPayload).not.toHaveBeenCalled();
	});

	it("is not in the way when no summary is wanted, inside a call or outside one", async () => {
		mocks.hasLocalDistillEnabled.mockResolvedValue(false);
		await expect(decideLocalDistill(params)).resolves.toEqual({
			shouldDistill: false,
		});
		mocks.hasLocalDistillEnabled.mockResolvedValue(true);
		mocks.isCloudModel.mockResolvedValue(false);
		await expect(decideLocalDistill(params)).resolves.toEqual({
			shouldDistill: false,
		});
		expect(mocks.distillConnectorPayload).not.toHaveBeenCalled();
	});

	it("refuses through the shared gate the tools use as well", async () => {
		await expect(
			applyLocalDistillGate({
				...params,
				outcome: { modelPayload: { success: true } },
				onDistilled: (outcome) => outcome,
				onUnavailable: (outcome) => outcome,
			}),
		).rejects.toThrow(/outside a tool call/);
		expect(mocks.distillConnectorPayload).not.toHaveBeenCalled();
	});
});

// The proactive connector block is the one summary that is not a tool's result:
// it is spliced into this turn's prompt, and an address in the prompt never
// counts for fetch_url or produce_file. It says so by asking for itself.
describe("decideLocalDistillForPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		distillOn();
	});

	it("summarises outside a tool call, and marks nothing", async () => {
		await expect(decideLocalDistillForPrompt(params)).resolves.toEqual({
			shouldDistill: true,
			distilled: "A standup.",
		});
		expect(mocks.distillConnectorPayload).toHaveBeenCalledTimes(1);
	});

	it("leaves a tool call it happens to run in unmarked: it is not that call's result", async () => {
		const metadata = await inToolCall(async () => {
			await decideLocalDistillForPrompt(params);
		});
		expect(metadata).not.toHaveProperty("localDistilled");
	});
});

// A caller added later has to be a decision. `decideLocalDistill` and the gate
// built on it are for tools, which run in the envelope (the refusal above is
// what happens if one does not); the prompt-only variant has one caller, the
// proactive stage, and a second one is a review.
describe("who asks for a summary", () => {
	const SERVER = join(process.cwd(), "src", "lib", "server");

	function sources(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) return sources(path);
			return /\.(ts|svelte)$/.test(name) && !/\.test\./.test(name)
				? [path]
				: [];
		});
	}

	const files = sources(SERVER).map((path) => ({
		name: relative(SERVER, path),
		text: readFileSync(path, "utf8"),
	}));
	const importing = (symbol: string) =>
		files
			.filter(
				(file) =>
					!file.name.endsWith("connector-distill.ts") &&
					new RegExp(
						`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*["'][^"']*connector-distill["']`,
					).test(file.text),
			)
			.map((file) => file.name)
			.sort();

	it("asks for a marked summary only from tools", () => {
		for (const symbol of ["decideLocalDistill", "applyLocalDistillGate"]) {
			const callers = importing(symbol);
			expect(callers.length, symbol).toBeGreaterThan(0);
			for (const caller of callers) {
				expect(caller, symbol).toMatch(/^services\/normal-chat-tools\//);
			}
		}
	});

	it("asks for a prompt-only summary from the proactive stage alone", () => {
		expect(importing("decideLocalDistillForPrompt")).toEqual([
			"services/chat-turn/proactive-connector-context.ts",
		]);
	});
});
