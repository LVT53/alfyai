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
	it.each([
		"activity",
		"provisional",
	] as const)("hides live %s prose even when expanded", async (role) => {
		render(ThinkingBlock, {
			output: view([{ ...commentary[0], role }]),
			thinkingIsDone: false,
		});
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
		expect(screen.queryByText(commentary[0].text)).toBeNull();
	});
	it.each([
		"stopped",
		"paused",
		"incomplete",
		"failed",
	] as const)("requires a fresh terminal disclosure for %s", async (outcome) => {
		const { rerender } = render(ThinkingBlock, {
			output: view(),
			thinkingIsDone: false,
		});
		await fireEvent.click(screen.getByRole("button"));
		await rerender({ output: view(commentary, outcome), thinkingIsDone: true });
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
		const header = screen.getByRole("button", { name: /Previous activity/ });
		// A live expansion never authorizes retained prose. Close and explicitly reopen.
		if (header.getAttribute("aria-expanded") === "true")
			await fireEvent.click(header);
		await fireEvent.click(header);
		expect(screen.getByTestId("normal-chat-commentary")).toHaveTextContent(
			commentary[0].text,
		);
		expect(document.querySelector("img")).toBeNull();
	});
	it.each([
		undefined,
		"answered",
		"delivered",
	] as const)("never discloses prose with completion %s", async (outcome) => {
		render(ThinkingBlock, {
			output: view(commentary, outcome),
			thinkingIsDone: true,
		});
		const header = screen.queryByRole("button");
		if (header) await fireEvent.click(header);
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
	});
	it.each([
		["answered", false],
		["answered", true],
		["delivered", false],
		["delivered", true],
	] as const)("immediately hides disclosed activity at %s, reduced motion=%s", async (outcome, reduced) => {
		vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
		const { rerender } = render(ThinkingBlock, {
			output: view(commentary, "paused"),
			thinkingIsDone: true,
		});
		await fireEvent.click(screen.getByRole("button"));
		expect(screen.getByTestId("normal-chat-commentary")).toBeTruthy();
		await rerender({ output: view(commentary, outcome), thinkingIsDone: true });
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
	});
	it("does not reuse another segment's disclosure", async () => {
		const { rerender } = render(ThinkingBlock, {
			output: view(commentary, "paused"),
			thinkingIsDone: true,
		});
		await fireEvent.click(screen.getByRole("button"));
		expect(screen.getByTestId("normal-chat-commentary")).toBeTruthy();
		const next = view(
			commentary.map((b) => ({ ...b, segmentId: "next" })),
			"paused",
		);
		if (next.completion)
			next.completion = { ...next.completion, segmentId: "next" };
		await rerender({ output: next, thinkingIsDone: true });
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
	});
	it("requires fresh access when returning to a previously disclosed segment", async () => {
		const original = view(commentary, "paused");
		const { rerender } = render(ThinkingBlock, {
			output: original,
			thinkingIsDone: true,
		});
		await fireEvent.click(screen.getByRole("button"));
		const next = view(
			commentary.map((b) => ({ ...b, segmentId: "next" })),
			"paused",
		);
		if (next.completion)
			next.completion = { ...next.completion, segmentId: "next" };
		await rerender({ output: next, thinkingIsDone: true });
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
		await rerender({ output: original, thinkingIsDone: true });
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
	});
	it("keeps an explicitly opened paused segment visible when another segment runs", async () => {
		const paused = render(ThinkingBlock, {
			output: view(commentary, "paused"),
			thinkingIsDone: true,
		});
		await fireEvent.click(screen.getByRole("button"));
		render(ThinkingBlock, { output: view(), thinkingIsDone: false });
		expect(paused.getByTestId("normal-chat-commentary")).toHaveTextContent(
			commentary[0].text,
		);
	});
	it("does not reuse a disclosure after the same segment becomes live again", async () => {
		const { rerender } = render(ThinkingBlock, {
			output: view(commentary, "paused"),
			thinkingIsDone: true,
		});
		await fireEvent.click(screen.getByRole("button"));
		await rerender({ output: view(), thinkingIsDone: false });
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
		await rerender({
			output: view(commentary, "paused"),
			thinkingIsDone: true,
		});
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
	});
	it.each([
		[
			'Before.<skill_control_v1>{"version":1,"operations":[]}</skill_control_v1>After.',
			"Before.After.",
		],
		[
			'Before.<skill_control_v1>{"version":1,"operations":[]}\n</skill_control_v',
			"Before.",
		],
		[
			'Before.<skill_control_v1>{"version":1,"operations":[]}</skill_control_v1>Ordinary <',
			"Before.Ordinary <",
		],
		["Ordinary <", "Ordinary <"],
		["Ordinary </skill_control_v", "Ordinary </skill_control_v"],
	])("sanitizes explicitly disclosed retained activity: %s", async (text, expected) => {
		const blocks = [{ ...commentary[0], text }];
		render(ThinkingBlock, {
			output: view(blocks, "incomplete"),
			thinkingIsDone: true,
		});
		expect(screen.queryByTestId("normal-chat-commentary")).toBeNull();
		await fireEvent.click(
			screen.getByRole("button", { name: /Previous activity/ }),
		);
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe(expected);
		expect(blocks[0].text).toBe(text);
	});
	it.each([
		true,
		false,
	])("hides interrupted control closing syntax with ended=%s", async (ended) => {
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
		await fireEvent.click(screen.getByRole("button"));
		expect(
			screen.getByTestId("normal-chat-commentary").textContent?.trim(),
		).toBe("Before.");
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
