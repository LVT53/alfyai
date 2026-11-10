import { describe, expect, it } from "vitest";
import {
	type NormalChatCompletion,
	parseNormalChatFinalization,
	projectNormalChatFinalization,
} from "./normal-chat-completion";

const model: NormalChatCompletion = {
	version: 1,
	turnId: "t",
	segmentId: "s",
	phase: "closing",
	outcome: "answered",
	stopCause: "natural_stop",
	workingStopCause: "tool_budget",
	closingAttempted: true,
};
const marker = {
	version: 1,
	status: "failed",
	cause: "file_association_failed",
	wasStopped: false,
} as const;
describe("normal chat finalization projection", () => {
	it("parses the explicit versioned failure only", () => {
		expect(parseNormalChatFinalization(marker)).toEqual(marker);
	});
	it.each([
		undefined,
		{},
		{ ...marker, version: 2 },
		{ ...marker, cause: "provider_error" },
		{ ...marker, wasStopped: "false" },
	])("rejects malformed finalization %j", (value) => {
		expect(parseNormalChatFinalization(value)).toBeUndefined();
	});
	it("overlays outward failure without changing model facts", () => {
		const before = { ...model };
		expect(projectNormalChatFinalization(model, marker)).toEqual({
			...model,
			outcome: "failed",
			stopCause: "uncertain_execution",
		});
		expect(model).toEqual(before);
	});
	it("preserves explicit stop and its separate finalization fact", () => {
		expect(
			projectNormalChatFinalization(model, { ...marker, wasStopped: true }),
		).toMatchObject({ outcome: "stopped", stopCause: "user_stop" });
		expect(
			projectNormalChatFinalization(
				{ ...model, outcome: "stopped", stopCause: "user_stop" },
				marker,
			),
		).toMatchObject({ outcome: "stopped", stopCause: "user_stop" });
	});
	it("does not invent missing model completion and preserves unmarked identity", () => {
		expect(projectNormalChatFinalization(undefined, marker)).toBeUndefined();
		expect(projectNormalChatFinalization(model, undefined)).toBe(model);
	});
});
