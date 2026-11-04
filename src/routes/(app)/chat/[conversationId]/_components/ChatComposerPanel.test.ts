import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposerPanel from "./ChatComposerPanel.svelte";

beforeEach(() => {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
});

function renderComposerPanel(props: Record<string, unknown> = {}) {
	return render(ChatComposerPanel, {
		props: {
			sendError: null,
			canRetry: true,
			onRetry: vi.fn(),
			onErrorClose: vi.fn(),
			onSend: vi.fn(),
			onQueue: vi.fn(),
			onStop: vi.fn(),
			onDraftChange: vi.fn(),
			onEditQueuedMessage: vi.fn(),
			onDeleteQueuedMessage: vi.fn(),
			onCompact: vi.fn(),
			disabled: false,
			isGenerating: false,
			hasQueuedMessage: false,
			queuedMessagePreview: "",
			maxLength: 12000,
			conversationId: "conv-1",
			contextStatus: null,
			attachedArtifacts: [],
			contextDebug: null,
			draftText: "",
			draftAttachments: [],
			draftVersion: 0,
			totalCostUsd: 0,
			totalTokens: 0,
			composerCommandRegistryEnabled: false,
			personalityProfiles: [],
			selectedPersonalityId: null,
			onPersonalityChange: vi.fn(),
			...props,
		},
	});
}

describe("ChatComposerPanel", () => {
	it("does not expose the removed long-form research composer control", async () => {
		const { getByPlaceholderText, queryByRole } = renderComposerPanel({
			composerCommandRegistryEnabled: true,
		});
		const removedLabel = ["Deep", "Research"].join(" ");

		expect(queryByRole("button", { name: removedLabel })).toBeNull();

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "/removed-command" },
		});

		expect(queryByRole("option", { name: removedLabel })).toBeNull();
	});

	it("passes the Composer Command Registry feature flag into the composer", async () => {
		const { getByPlaceholderText, queryByRole, rerender } = renderComposerPanel(
			{
				composerCommandRegistryEnabled: false,
			},
		);

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "/" },
		});

		expect(queryByRole("listbox", { name: "Composer commands" })).toBeNull();

		await rerender({
			composerCommandRegistryEnabled: true,
		});
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "/" },
		});

		expect(
			queryByRole("listbox", { name: "Composer commands" }),
		).not.toBeNull();
	});

	// Everyday redesign: the ring is a measurement, so it appears only once
	// there is context to measure — this hands it some.
	it("forwards restored linked sources and pending skill into the composer", () => {
		const { getByText, getByRole } = renderComposerPanel({
			composerCommandRegistryEnabled: true,
			draftLinkedSources: [
				{
					displayArtifactId: "display-wrapper",
					promptArtifactId: "prompt-wrapper",
					familyArtifactIds: ["display-wrapper", "prompt-wrapper"],
					name: "Wrapper source.md",
					type: "document",
				},
			],
			draftPendingSkill: {
				id: "skill-wrapper",
				ownership: "user",
				displayName: "Wrapper Skill",
			},
			draftVersion: 1,
		});

		expect(getByText("Wrapper source.md")).toBeInTheDocument();
		expect(getByText("Wrapper Skill")).toBeInTheDocument();
		expect(
			getByRole("button", {
				name: "Remove linked document Wrapper source.md",
			}),
		).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Remove pending skill Wrapper Skill" }),
		).toBeInTheDocument();
	});

	it("forwards a restored draft and a chat switch into the composer", async () => {
		const { getByPlaceholderText, rerender } = renderComposerPanel();
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "C typed" } });

		// A turn put its words back behind the ones typed since.
		await rerender({
			draftText: "C typed\n\nB queued",
			draftVersion: 5,
			draftTakeoverVersion: 5,
		});
		await waitFor(() => expect(input.value).toBe("C typed\n\nB queued"));

		// Another chat replaced this one.
		await rerender({
			conversationId: "conv-2",
			resetRequest: 1,
			draftText: "B's own draft",
			draftVersion: 9,
			draftTakeoverVersion: 0,
		});
		await waitFor(() => expect(input.value).toBe("B's own draft"));
	});

	it("sends normal chat payloads without removed research fields", async () => {
		const onSend = vi.fn();
		const removedDepthKey = ["deep", "Research", "Depth"].join("");
		const { getByPlaceholderText, getByRole } = renderComposerPanel({
			onSend,
		});

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Research battery recycling policy" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(onSend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Research battery recycling policy",
			}),
		);
		expect(onSend.mock.calls[0]?.[0]).not.toHaveProperty(removedDepthKey);
	});

	// R1 (ADR-0060) — the composer must not offer a Retry affordance the
	// runtime has already said it will refuse.
	it("does not render a retry affordance when canRetry is false", () => {
		const { queryByRole } = renderComposerPanel({
			sendError: "Skill session could not be recovered",
			canRetry: false,
		});

		expect(queryByRole("button", { name: /retry/i })).toBeNull();
	});

	it("renders a retry affordance when canRetry is true", () => {
		const { getByRole } = renderComposerPanel({
			sendError: "Something went wrong",
			canRetry: true,
		});

		expect(getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});

	// "Ask me first": while Alfy waits for an answer the message box is off, and drawn
	// at half strength (the mockup's `.composer:has(.waiting)`). Off is the page's
	// `disabled`; this prop is the look, and nothing else about the box.
	it("dims the composer while a question waits", async () => {
		const { getByTestId, getByText, rerender } = renderComposerPanel({
			draftText: "Words typed meanwhile",
			draftVersion: 1,
			sendError: "Something went wrong",
		});
		const box = getByTestId("composer-box");
		const textarea = getByTestId("message-input") as HTMLTextAreaElement;
		expect(box).toContainElement(textarea);
		expect(box).not.toHaveAttribute("data-waiting-for-answer");

		await rerender({ waitingForAnswer: true, disabled: true });

		expect(box).toHaveAttribute("data-waiting-for-answer", "true");
		// Off, with the person's words still in it.
		expect(textarea).toBeDisabled();
		expect(textarea).toHaveValue("Words typed meanwhile");
		// The error above the box is not part of what is dimmed.
		expect(box).not.toContainElement(getByText("Something went wrong"));
		// Half strength, in the stylesheet that the attribute selects.
		const source = readFileSync(
			resolve(__dirname, "ChatComposerPanel.svelte"),
			"utf8",
		);
		expect(source).toMatch(
			/\.composer-box\[data-waiting-for-answer\]\s*\{[^}]*opacity:\s*0\.5\s*;/,
		);

		await rerender({ waitingForAnswer: false, disabled: false });

		expect(box).not.toHaveAttribute("data-waiting-for-answer");
		expect(textarea).not.toBeDisabled();
		expect(textarea).toHaveValue("Words typed meanwhile");
	});

	it("does not send from a disabled composer", async () => {
		const onSend = vi.fn();
		const { getByPlaceholderText, getByRole } = renderComposerPanel({
			disabled: true,
			onSend,
		});

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Try to continue the sealed conversation" },
		});

		expect(getByRole("button", { name: "Send message" })).toBeDisabled();

		await fireEvent.keyDown(getByPlaceholderText("Type a message..."), {
			key: "Enter",
		});

		expect(onSend).not.toHaveBeenCalled();
	});
});
