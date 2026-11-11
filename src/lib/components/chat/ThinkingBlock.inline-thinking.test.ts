import { fireEvent, render, screen } from "@testing-library/svelte";
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
		expect(shown).toContain("Visible narration.");
	});
});
