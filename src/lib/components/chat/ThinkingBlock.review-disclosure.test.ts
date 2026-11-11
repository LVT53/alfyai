import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalChatCompletion } from "$lib/shared/normal-chat-completion";
import type {
	NormalChatOutputBlock,
	NormalChatOutputProjection,
} from "$lib/shared/normal-chat-output";
import { uiLanguage } from "$lib/stores/settings";
import ThinkingBlock from "./ThinkingBlock.svelte";

const block = (
	text: string,
	role: "activity" | "provisional" = "provisional",
): NormalChatOutputBlock => ({
	version: 1,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "w",
	phase: "working",
	blockId: "b",
	nativeId: "n",
	kind: "text",
	role,
	text,
	ended: true,
});
function view(
	blocks: NormalChatOutputBlock[],
	outcome?: NormalChatCompletion["outcome"],
	segmentId = "s",
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
						segmentId,
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

describe("review D: ThinkingBlock disclosure", () => {
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

	it("X1: retained activity shows raw inline <think> reasoning verbatim", async () => {
		const blocks = [
			block("<think>PRIVATE-REASONING-MARKER</think>Visible narration."),
		];
		render(ThinkingBlock, {
			output: view(blocks, "stopped"),
			thinkingIsDone: true,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous activity/ }),
		);
		const shown =
			screen.getByTestId("normal-chat-commentary").textContent ?? "";
		console.log("X1 shown:", JSON.stringify(shown));
		expect(shown).not.toContain("PRIVATE-REASONING-MARKER");
	});

	it("X2: A -> B -> A batched in one tick keeps the disclosure of A", async () => {
		const a = view([block("Prose A")], "paused", "s");
		const b = view([block("Prose B")], "paused", "other");
		const { rerender } = render(ThinkingBlock, {
			output: a,
			thinkingIsDone: true,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous activity/ }),
		);
		expect(screen.getByTestId("normal-chat-commentary")).toBeTruthy();
		// two prop updates inside one tick, no effect flush between
		const first = rerender({ output: b, thinkingIsDone: true });
		const second = rerender({ output: a, thinkingIsDone: true });
		await Promise.all([first, second]);
		await tick();
		const visible = screen.queryByTestId("normal-chat-commentary");
		console.log("X2 visible after batched A->B->A:", Boolean(visible));
		expect(visible).toBeNull();
	});

	it("X3: terminal -> null -> same terminal batched in one tick keeps the disclosure", async () => {
		const a = view([block("Prose A")], "paused", "s");
		const { rerender } = render(ThinkingBlock, {
			output: a,
			thinkingIsDone: true,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous activity/ }),
		);
		expect(screen.getByTestId("normal-chat-commentary")).toBeTruthy();
		const first = rerender({
			output: view([block("Prose A")]),
			thinkingIsDone: false,
		});
		const second = rerender({ output: a, thinkingIsDone: true });
		await Promise.all([first, second]);
		await tick();
		const visible = screen.queryByTestId("normal-chat-commentary");
		console.log("X3 visible after batched A->live->A:", Boolean(visible));
		expect(visible).toBeNull();
	});

	it("X4: opening the rail with native reasoning present also discloses the retained activity in one click", async () => {
		const blocks = [block("Retained prose")];
		render(ThinkingBlock, {
			content: "native reasoning trace",
			output: view(blocks, "stopped"),
			thinkingIsDone: true,
		});
		const header = screen.getByRole("button", { name: /Thought/ });
		await fireEvent.click(header);
		const shown = screen.queryByTestId("normal-chat-commentary");
		console.log("X4 disclosed on first expand:", Boolean(shown));
		expect(shown).not.toBeNull();
	});

	it("X5: provisional prose is never rendered live even with native reasoning and tools present", async () => {
		const blocks = [block("LIVE-PROSE-MARKER")];
		render(ThinkingBlock, {
			content: "native reasoning trace",
			output: view(blocks),
			thinkingIsDone: false,
			segments: [
				{
					type: "tool_call",
					name: "research_web",
					input: {},
					status: "running",
					callId: "c1",
				} as never,
			],
		});
		await fireEvent.click(screen.getAllByRole("button")[0]);
		expect(document.body.textContent).not.toContain("LIVE-PROSE-MARKER");
	});

	it("X6: repeated canonical adoption of the same completion keeps a disclosure and does not open raw reasoning", async () => {
		const a = view([block("Prose A")], "stopped", "s");
		const { rerender } = render(ThinkingBlock, {
			content: "native trace TRACE-MARKER",
			output: a,
			thinkingIsDone: true,
			thoughtSteps: undefined,
		});
		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
		expect(screen.getByTestId("normal-chat-commentary")).toBeTruthy();
		// canonical adoption: same identity, new objects, and anchored steps arrive
		const adopted = view([block("Prose A")], "stopped", "s");
		await rerender({
			output: adopted,
			thinkingIsDone: true,
			thoughtSteps: [
				{
					id: "step-1",
					anchor: { start: 0, end: 12 },
					activityClass: "reasoning",
					summary: "S",
					createdAt: 1,
					impliesExternalAction: false,
				} as never,
			],
		});
		expect(screen.queryByTestId("normal-chat-commentary")).not.toBeNull();
		expect(document.body.textContent).not.toContain("TRACE-MARKER");
	});
});
