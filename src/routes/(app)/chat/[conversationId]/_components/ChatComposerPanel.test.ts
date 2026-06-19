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

function renderComposerPanel(props: Record<string, unknown> = {}) {
	return render(ChatComposerPanel, {
		props: {
			sendError: null,
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
			onManageEvidence: vi.fn(),
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
