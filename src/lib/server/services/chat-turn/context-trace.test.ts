import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(() => ({ contextDiagnosticsDebug: true })),
}));

vi.mock("../../config-store", () => ({
	getConfig: mocks.getConfig,
}));

import { buildLegacyContextTrace, emitContextTrace } from "./context-trace";

describe("Context Trace", () => {
	it("does not emit traces unless context diagnostics are enabled", () => {
		mocks.getConfig.mockReturnValueOnce({ contextDiagnosticsDebug: false });
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const trace = buildLegacyContextTrace({
			conversationId: "conv-1",
			userId: "user-1",
			modelId: "model1",
			modelName: "local-model",
			attempt: 1,
			phase: "context_selection",
			contextSource: "live",
			budget: {
				maxModelContext: 10_000,
				targetConstructedContext: 6_000,
				reservedEstimate: 500,
				promptEstimate: 2_000,
				outputReserve: 1_000,
				wasBudgetEnforced: false,
			},
			sections: [],
			limitations: [],
			warnings: [],
			fallbacks: [],
		});

		emitContextTrace(trace);

		expect(info).not.toHaveBeenCalled();
	});

	it("emits one compact structured trace without prompt body text", () => {
		mocks.getConfig.mockReturnValueOnce({ contextDiagnosticsDebug: true });
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const trace = buildLegacyContextTrace({
			conversationId: "conv-1",
			streamId: "stream-1",
			userId: "user-1",
			modelId: "model1",
			providerId: null,
			modelName: "local-model",
			attempt: 1,
			phase: "context_selection",
			contextSource: "live",
			budget: {
				maxModelContext: 10_000,
				targetConstructedContext: 6_000,
				reservedEstimate: 500,
				promptEstimate: 2_000,
				outputReserve: 1_000,
				wasBudgetEnforced: false,
			},
			sections: [
				{
					name: "Current Attachments",
					source: "attachment",
					body: "private attachment body that must never be logged",
					itemIds: ["artifact-1"],
					itemTitles: ["contract.pdf"],
					signalReasons: ["attached_this_turn"],
					trimmed: false,
					protected: true,
				},
			],
			limitations: [],
			warnings: [],
			fallbacks: [],
		});

		emitContextTrace(trace);

		expect(info).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith(
			"[CONTEXT_TRACE]",
			expect.objectContaining({
				traceVersion: 1,
				conversationId: "conv-1",
				streamId: "stream-1",
				userId: "user-1",
				modelId: "model1",
				modelName: "local-model",
				attempt: 1,
				phase: "context_selection",
				contextSource: "live",
				sections: [
					expect.objectContaining({
						name: "Current Attachments",
						source: "attachment",
						estimatedTokens: expect.any(Number),
						itemCount: 1,
						itemIds: ["artifact-1"],
						itemTitles: ["contract.pdf"],
						signalReasons: ["attached_this_turn"],
						trimmed: false,
						protected: true,
					}),
				],
			}),
		);
		expect(JSON.stringify(info.mock.calls[0])).not.toContain(
			"private attachment body",
		);
	});

	it("preserves protected context inclusion levels from context selection", () => {
		const trace = buildLegacyContextTrace({
			conversationId: "conv-1",
			userId: "user-1",
			modelId: "model1",
			modelName: "local-model",
			attempt: 1,
			phase: "context_selection",
			contextSource: "live",
			budget: {
				maxModelContext: 10_000,
				targetConstructedContext: 6_000,
				reservedEstimate: 500,
				promptEstimate: 2_000,
				outputReserve: 1_000,
				wasBudgetEnforced: true,
			},
			sections: [
				{
					name: "Task State",
					source: "task_state",
					body: "",
					protected: true,
					trimmed: false,
					inclusionLevel: "omitted",
				} as never,
			],
			limitations: [],
			warnings: [],
			fallbacks: [],
		});

		expect(trace.sections[0]).toEqual(
			expect.objectContaining({
				name: "Task State",
				protected: true,
				trimmed: false,
				inclusionLevel: "omitted",
				estimatedTokens: 0,
			}),
		);
	});
});
