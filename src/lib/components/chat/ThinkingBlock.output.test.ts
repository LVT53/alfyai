import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalChatCompletion } from "$lib/shared/normal-chat-completion";
import type {
	NormalChatOutputBlock,
	NormalChatOutputProjection,
} from "$lib/shared/normal-chat-output";
import { uiLanguage } from "$lib/stores/settings";
import ThinkingBlock from "./ThinkingBlock.svelte";

const commentary: NormalChatOutputBlock[] = [
	{
		version: 1,
		turnId: "t",
		segmentId: "s",
		attemptId: "a",
		stepId: "w",
		phase: "working",
		blockId: "b",
		nativeId: "n",
		kind: "text",
		role: "activity",
		text: "Let me check. <img src=x onerror=alert(1)>",
		ended: true,
	},
];
function view(
	blocks = commentary,
	outcome?: NormalChatCompletion["outcome"],
): NormalChatOutputProjection {
	return {
		answer: "",
		activity: blocks,
		blocks,
		...(outcome
			? {
					completion: {
						version: 1,
						turnId: "t",
						segmentId: "s",
						phase: "working",
						outcome,
						stopCause: "stream_end",
						workingStopCause: "stream_end",
						closingAttempted: false,
					} as const,
				}
			: {}),
	};
}

describe("ordinary commentary in the existing activity disclosure", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		vi.spyOn(Element.prototype, "animate").mockImplementation(() => {
			const animation = {
				onfinish: null as (() => void) | null,
				finished: Promise.resolve(),
				cancel() {},
				effect: { getComputedTiming: () => ({ progress: 1 }) },
			};
			setTimeout(() => animation.onfinish?.(), 0);
			return animation as unknown as Animation;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("shows live escaped commentary separately from private reasoning", async () => {
		const { container } = render(ThinkingBlock, {
			output: view(),
			thinkingIsDone: false,
		});
		expect(screen.getByTestId("normal-chat-commentary").textContent).toContain(
			commentary[0].text,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(screen.queryByText("Thinking Trace")).toBeNull();
	});
	it.each([
		'<skill_control_v1>{"version":1,"operations":[{"operationId":"working-draft","kind":"skill_draft","draft":{"id":"digest","displayName":"Digest","instructions":"Summarize the notes."}}]}</skill_control_v1>',
		'<skill_control_v1>{"version":1,"operations":[',
		"<skill_control_v",
	])("hides explicit Skill Control syntax from live commentary: %s", (control) => {
		const blocks = [
			{ ...commentary[0], ended: false, text: `Let me check. ${control}` },
		];
		render(ThinkingBlock, { output: view(blocks), thinkingIsDone: false });
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Let me check.");
		expect(blocks[0].text).toBe(`Let me check. ${control}`);
	});

	it("preserves commentary around a complete Skill Control envelope in retained activity", async () => {
		const blocks = [
			{
				...commentary[0],
				text: 'Before.<skill_control_v1>{"version":1,"operations":[{"operationId":"working-draft","kind":"skill_draft","draft":{"id":"digest","displayName":"Digest","instructions":"Summarize the notes."}}]}</skill_control_v1>After.',
			},
		];
		render(ThinkingBlock, {
			output: view(blocks, "paused"),
			thinkingIsDone: true,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous activity/ }),
		);
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Before.After.");
	});

	it("Skill Control delimiter state hides incremental closing chunks until they finish", async () => {
		const envelope = 'Before.<skill_control_v1>{"version":1,"operations":[]}';
		const blocks = [{ ...commentary[0], ended: false, text: envelope }];
		const { rerender } = render(ThinkingBlock, {
			output: view(blocks),
			thinkingIsDone: false,
		});
		for (const closing of [
			"<",
			"</",
			"</skill_control_v",
			"</skill_control_v1>",
		]) {
			blocks[0].text = envelope + closing;
			await rerender({ output: view(blocks), thinkingIsDone: false });
			expect
				.soft(screen.getByTestId("normal-chat-commentary").textContent?.trim())
				.toBe("Before.");
		}
		blocks[0].text += "After.";
		await rerender({ output: view(blocks), thinkingIsDone: false });
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Before.After.");
		expect(blocks[0].text).toBe(`${envelope}</skill_control_v1>After.`);
	});

	it.each([
		true,
		false,
	])("Skill Control delimiter state hides interrupted closing syntax with ended=%s", async (ended) => {
		const blocks = [
			{
				...commentary[0],
				ended,
				text: 'Before.<skill_control_v1>{"version":1,"operations":[]}\n</skill_control_v',
			},
		];
		render(ThinkingBlock, {
			output: view(blocks, "incomplete"),
			thinkingIsDone: true,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous activity/ }),
		);
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Before.");
	});

	it.each([
		"Ordinary <",
		"Ordinary </skill_control_v",
	])("Skill Control delimiter state flushes completed ordinary text %s", (text) => {
		const blocks = [{ ...commentary[0], ended: true, text }];
		render(ThinkingBlock, { output: view(blocks), thinkingIsDone: false });
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe(text);
	});

	it.each([
		"block-end",
		"terminal",
	] as const)("Skill Control delimiter state releases live ambiguity on %s", async (finish) => {
		const blocks = [{ ...commentary[0], ended: false, text: "Ordinary <" }];
		const { rerender } = render(ThinkingBlock, {
			output: view(blocks),
			thinkingIsDone: false,
		});
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Ordinary");
		blocks[0].ended = finish === "block-end";
		await rerender({
			output: view(blocks, finish === "terminal" ? "incomplete" : undefined),
			thinkingIsDone: false,
		});
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Ordinary <");
	});

	it("Skill Control delimiter state preserves a finalized literal after a closed envelope", () => {
		const blocks = [
			{
				...commentary[0],
				text: 'Before.<skill_control_v1>{"version":1,"operations":[]}</skill_control_v1>Ordinary <',
			},
		];
		render(ThinkingBlock, { output: view(blocks), thinkingIsDone: false });
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Before.Ordinary <");
	});

	it("updates the same accumulator block as live deltas arrive", async () => {
		const blocks = commentary.map((b) => ({ ...b, text: "First" }));
		const { rerender } = render(ThinkingBlock, {
			output: view(blocks),
			thinkingIsDone: false,
		});
		blocks[0].text += " next";
		await rerender({ output: view(blocks), thinkingIsDone: false });
		expect(screen.getByTestId("normal-chat-commentary").textContent).toContain(
			"First next",
		);
	});
	it.each([
		"stopped",
		"paused",
		"incomplete",
		"failed",
	] as const)("retains %s activity in the existing disclosure after reload", async (outcome) => {
		render(ThinkingBlock, {
			output: view(commentary, outcome),
			thinkingIsDone: true,
		});
		const header = screen.getByRole("button", { name: /Previous activity/ });
		await fireEvent.click(header);
		expect(screen.getByTestId("normal-chat-commentary").textContent).toContain(
			commentary[0].text,
		);
	});
	it.each([
		false,
		true,
	])("removes successful commentary at terminal under reduced motion=%s", async (reduced) => {
		vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
		const { rerender } = render(ThinkingBlock, {
			output: view(),
			thinkingIsDone: false,
		});
		expect(screen.getByTestId("normal-chat-commentary")).toBeTruthy();
		await rerender({
			output: view(commentary, "answered"),
			thinkingIsDone: true,
		});
		await vi.waitFor(() =>
			expect(screen.queryByTestId("normal-chat-commentary")).toBeNull(),
		);
	});
	it("labels retained activity in Hungarian", () => {
		uiLanguage.set("hu");
		render(ThinkingBlock, {
			output: view(commentary, "paused"),
			thinkingIsDone: true,
		});
		expect(
			screen.getByRole("button", { name: /Korábbi tevékenység/ }),
		).toBeTruthy();
	});
});
