import { fireEvent, render } from "@testing-library/svelte";
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

function renderComposerPanel(
	props: Partial<Parameters<typeof render>[1]> = {},
) {
	return render(ChatComposerPanel, {
		sendError: null,
		onRetry: vi.fn(),
		onErrorClose: vi.fn(),
		onSend: vi.fn(),
		onQueue: vi.fn(),
		onStop: vi.fn(),
		onDraftChange: vi.fn(),
		onEditQueuedMessage: vi.fn(),
		onDeleteQueuedMessage: vi.fn(),
		disabled: false,
		isGenerating: false,
		hasQueuedMessage: false,
		queuedMessagePreview: "",
		maxLength: 12000,
		conversationId: "conv-1",
		contextStatus: null,
		attachedArtifacts: [],
		taskState: null,
		contextDebug: null,
		draftText: "",
		draftAttachments: [],
		draftVersion: 0,
		onSteer: vi.fn(),
		onManageEvidence: vi.fn(),
		totalCostUsd: 0,
		totalTokens: 0,
		composerCommandRegistryEnabled: false,
		personalityProfiles: [],
		selectedPersonalityId: null,
		onPersonalityChange: vi.fn(),
		...props,
	});
}

describe("ChatComposerPanel", () => {
	it("passes the Deep Research feature flag into the composer", async () => {
		const { queryByRole, rerender } = renderComposerPanel({
			deepResearchEnabled: false,
		});

		expect(queryByRole("button", { name: "Deep Research" })).toBeNull();

		await rerender({
			deepResearchEnabled: true,
		});

		expect(queryByRole("button", { name: "Deep Research" })).not.toBeNull();
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

	it("forwards the context source management action into the composer ring", async () => {
		const onManageEvidence = vi.fn();
		const { getByLabelText, getByRole } = renderComposerPanel({
			onManageEvidence,
		});

		await fireEvent.click(getByLabelText("No context yet"));
		await fireEvent.click(
			getByRole("button", { name: "Manage context sources" }),
		);

		expect(onManageEvidence).toHaveBeenCalledTimes(1);
	});

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
			getByRole("button", { name: "Remove Wrapper source.md" }),
		).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Remove pending skill Wrapper Skill" }),
		).toBeInTheDocument();
	});

	it("passes the selected Deep Research depth through chat sends", async () => {
		const onSend = vi.fn();
		const { getByPlaceholderText, getByRole } = renderComposerPanel({
			deepResearchEnabled: true,
			onSend,
		});

		await fireEvent.click(getByRole("button", { name: "Deep Research" }));
		await fireEvent.click(
			getByRole("button", { name: "Focused Deep Research" }),
		);
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Research battery recycling policy" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(onSend).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Research battery recycling policy",
				deepResearchDepth: "focused",
			}),
		);
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
