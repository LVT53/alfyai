import { readFileSync } from "node:fs";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableModelsResponse } from "$lib/client/api/models";
import type { PendingAttachment } from "$lib/server/services/knowledge/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { getAcceptAttribute } from "$lib/shared/file-types";
import { requestComposerQuote } from "$lib/stores/composer-quote";
import { selectedModel, uiLanguage } from "$lib/stores/settings";
import {
	resetDisabledFileTypeIds,
	setDisabledFileTypeIds,
} from "$lib/stores/upload-format-gate";
import {
	resetMaxFileUploadSize,
	setMaxFileUploadSize,
} from "$lib/stores/upload-limits";
import MessageInput from "./MessageInput.svelte";
import MessageInputWrapper from "./MessageInputWrapper.test.svelte";

type UploadDoneResult =
	| {
			success: true;
			attachment: PendingAttachment;
			extraction?: DocumentExtractionJobDTO | null;
	  }
	| { success: false; fileName: string; error: string };

type UploadFilesPayload = {
	files: File[];
	conversationId: string;
	done: (result: UploadDoneResult) => void;
};

function completeUpload(
	doneCallback: ((result: UploadDoneResult) => void) | null,
	result: UploadDoneResult,
) {
	if (!doneCallback) {
		throw new Error("Upload completion callback was not registered.");
	}
	doneCallback(result);
}

function getRegisteredUpload(
	uploadFn: ((files: FileList | null) => Promise<void>) | null,
): (files: FileList | null) => Promise<void> {
	if (!uploadFn) {
		throw new Error("Upload function was not registered.");
	}
	return uploadFn;
}

function spyOnScrollIntoView() {
	const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
	if (!originalScrollIntoView) {
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: vi.fn(),
		});
	}
	const spy = vi
		.spyOn(HTMLElement.prototype, "scrollIntoView")
		.mockImplementation(() => undefined);

	return {
		spy,
		restore() {
			spy.mockRestore();
			if (!originalScrollIntoView) {
				Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
			}
		},
	};
}

const fetchKnowledgeLibraryMock = vi.hoisted(() => vi.fn());
const discoverSkillsMock = vi.hoisted(() => vi.fn());
const setConversationMemoryIncognitoMock = vi.hoisted(() => vi.fn());
const fetchConversationMarkdownExportMock = vi.hoisted(() => vi.fn());
const fetchActiveCapabilitiesMock = vi.hoisted(() => vi.fn());
const addMemoryNoteMock = vi.hoisted(() => vi.fn());
const saveBlobAsDownloadMock = vi.hoisted(() => vi.fn());
const gotoMock = vi.hoisted(() => vi.fn());
const recordComposerCommandUsedMock = vi.hoisted(() => vi.fn());
// Baked-in default (not just a per-test mockResolvedValue) so every describe
// block in this file gets a resolved value even without its own setup —
// vi.clearAllMocks() clears call history but not a mockImplementation set at
// creation, so this survives across the whole file's describe blocks.
const fetchAvailableModelsMock = vi.hoisted(() =>
	vi.fn(async (): Promise<AvailableModelsResponse> => ({ providers: [] })),
);

const fetchExtractionJobsMock = vi.hoisted(() =>
	vi.fn(async (): Promise<unknown[]> => []),
);
const retryExtractionMock = vi.hoisted(() => vi.fn());
const cancelExtractionMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/client/api/knowledge", () => ({
	fetchKnowledgeLibrary: fetchKnowledgeLibraryMock,
	fetchExtractionJobs: fetchExtractionJobsMock,
	retryExtraction: retryExtractionMock,
	cancelExtraction: cancelExtractionMock,
}));

// ADR-0061 — the composer's thinking toggle looks up the selected model's
// `supportsReasoningControls` flag through this same fetch ModelSelector
// uses. Defaults to an empty provider list (so the toggle defaults to
// visible); individual tests override this to exercise the hidden case.
vi.mock("$lib/client/api/models", () => ({
	fetchAvailableModels: fetchAvailableModelsMock,
}));

vi.mock("$lib/client/api/skills", () => ({
	discoverSkills: discoverSkillsMock,
}));

vi.mock("$lib/client/api/conversations", () => ({
	setConversationMemoryIncognito: setConversationMemoryIncognitoMock,
	fetchConversationMarkdownExport: fetchConversationMarkdownExportMock,
}));

// Issue 7.4 fix pass — MessageInput no longer imports checkCloudWarning/
// ackCloudConnector/setLocalDistill itself (that gate now lives at the page
// level, driven into this component via the `beforeSend` prop — see the
// "MessageInput send gate (beforeSend contract)" describe block below and
// src/routes/(app)/chat/[conversationId]/page-runtime.test.ts for the
// full check+modal+ack/cancel scenarios). Only the capability *list* fetch
// remains local to this component.
vi.mock("$lib/client/api/connections", () => ({
	fetchActiveCapabilities: fetchActiveCapabilitiesMock,
}));

vi.mock("$lib/client/api/memory-notes", () => ({
	addMemoryNote: addMemoryNoteMock,
}));

vi.mock("$lib/client/api/settings", () => ({
	saveBlobAsDownload: saveBlobAsDownloadMock,
}));

vi.mock("$app/navigation", () => ({
	goto: gotoMock,
}));

vi.mock("$lib/client/composer-command-analytics", () => ({
	recordComposerCommandUsed: recordComposerCommandUsedMock,
}));

// Everyday redesign — the "+" menu holds everything the composer can do that
// is not one of the three resting icons. Tests that reach one of those
// controls open it first.
async function openComposerMenu(
	getByTestId: (id: string) => HTMLElement,
): Promise<HTMLElement> {
	await fireEvent.click(getByTestId("composer-tools-trigger"));
	return getByTestId("composer-tools-menu");
}

describe("MessageInput", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		selectedModel.set("model1");
		resetMaxFileUploadSize();
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		addMemoryNoteMock.mockResolvedValue({ id: "item-1", statement: "" });
		fetchConversationMarkdownExportMock.mockResolvedValue({
			markdown: "# Conversation\n",
			filename: "conversation.md",
		});
		gotoMock.mockResolvedValue(undefined);
	});

	it("renders correctly", () => {
		const { getByPlaceholderText } = render(MessageInput);
		expect(getByPlaceholderText("Type a message...")).toBeDefined();
	});

	it("disables send button when input is empty", () => {
		const { getByLabelText } = render(MessageInput);
		const button = getByLabelText("Send message") as HTMLButtonElement;

		expect(button.disabled).toBe(true);
	});

	it("enables send button when input has text", async () => {
		const { getByPlaceholderText, getByLabelText } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const button = getByLabelText("Send message") as HTMLButtonElement;

		await fireEvent.input(input, { target: { value: "Hello" } });
		expect(button.disabled).toBe(false);
	});

	it("renders typed URLs as clickable blank-tab links without replacing the textarea", async () => {
		const { container, getByPlaceholderText, getByRole } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: "Read https://example.com/report and www.example.org" },
		});

		const secureLink = getByRole("link", {
			name: "https://example.com/report",
		});
		expect(secureLink).toHaveAttribute("href", "https://example.com/report");
		expect(secureLink).toHaveAttribute("target", "_blank");
		expect(secureLink.getAttribute("rel")).toContain("noopener");
		expect(secureLink.getAttribute("rel")).toContain("noreferrer");

		const bareLink = getByRole("link", { name: "www.example.org" });
		expect(bareLink).toHaveAttribute("href", "https://www.example.org");
		expect(input.value).toBe(
			"Read https://example.com/report and www.example.org",
		);
		expect(input).toHaveClass("composer-textarea--link-overlay-active");
		expect(
			container.querySelector(".composer-link-highlights"),
		).toHaveTextContent("Read https://example.com/report and www.example.org");
	});

	// Was "from the composer tools toggle", which the "+" menu no longer has.
	// The chip is the part that survived the switch's removal, so it is the
	// part this now exercises: `/web` raises it, and it is what carries the
	// force onto the message.
	it("sends one-turn Web search from the chip the /web command raises", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
		});

		const commandInput = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(commandInput, { target: { value: "/web" } });
		await fireEvent.keyDown(commandInput, { key: "Enter", shiftKey: false });

		expect(
			getByRole("button", { name: "Remove Web search" }),
		).toBeInTheDocument();
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Find current SvelteKit release notes" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Find current SvelteKit release notes",
				forceWebSearch: true,
			}),
		);
	});

	it("selects an Atlas profile from composer tools and sends an Atlas turn", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			onSend: sendSpy,
			atlasAvailability: { enabled: true, configured: true },
		});

		await fireEvent.click(getByRole("button", { name: "Open composer tools" }));
		await fireEvent.click(getByRole("menuitem", { name: "Atlas report" }));
		const pickerSurface = getByRole("region", {
			name: "Choose an Atlas profile",
		});
		expect(pickerSurface).toHaveTextContent(
			"Deeper reports take more time and sources.",
		);
		expect(pickerSurface).toHaveTextContent(
			"A concise snapshot with key takeaways and a handful of sources.",
		);
		expect(pickerSurface).toHaveTextContent("~30+ min");
		const profilePicker = within(pickerSurface).getByRole("listbox", {
			name: "Atlas profile",
		});
		await fireEvent.click(
			within(profilePicker).getByRole("option", {
				name: "In-Depth",
			}),
		);

		// Chips redesign: one row for everything, and the Atlas profile moved
		// out of the SHOUTED label and into the muted meta clause.
		const chipRow = getByRole("list", { name: "Attached to this message" });
		expect(chipRow).toHaveTextContent("Atlas");
		expect(chipRow).toHaveTextContent("In-Depth · ~10-20 min");
		expect(chipRow.querySelector('[data-chip-kind="atlas"]')).not.toBeNull();

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Research SvelteKit load invalidation" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Research SvelteKit load invalidation",
				atlasMode: true,
				atlasProfile: "in-depth",
				atlasAction: "create",
				clientAtlasTurnId: expect.stringMatching(/^atlas-/),
			}),
		);
	});

	it("localizes the Atlas profile picker in Hungarian", async () => {
		uiLanguage.set("hu");
		const { getByRole } = render(MessageInput, {
			atlasAvailability: { enabled: true, configured: true },
		});

		await fireEvent.click(
			getByRole("button", { name: "Szerkesztőeszközök megnyitása" }),
		);
		await fireEvent.click(getByRole("menuitem", { name: "Atlas jelentés" }));

		const pickerSurface = getByRole("region", {
			name: "Válassz Atlas profilt",
		});
		expect(pickerSurface).toHaveTextContent(
			"A mélyebb jelentések több időt és forrást igényelnek.",
		);
		expect(pickerSurface).toHaveTextContent("Részletes");
		expect(pickerSurface).toHaveTextContent("~10-20 perc");
		expect(pickerSurface).toHaveTextContent(
			"Kiegyensúlyozott szélesség és részletesség",
		);
	});

	it("shows a localized disabled Atlas explanation when availability is incomplete", async () => {
		const { getByRole } = render(MessageInput, {
			atlasAvailability: {
				enabled: true,
				configured: false,
				reason: "Atlas requires web search before it can start.",
			},
		});

		await fireEvent.click(getByRole("button", { name: "Open composer tools" }));
		const atlasButton = getByRole("menuitem", { name: "Atlas unavailable" });

		expect(atlasButton).toBeDisabled();
		expect(atlasButton).toHaveAttribute(
			"title",
			"Atlas requires web search before it can start.",
		);
	});

	it("removes the Atlas chip before send", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByText } = render(
			MessageInput,
			{
				onSend: sendSpy,
				atlasAvailability: { enabled: true, configured: true },
			},
		);

		await fireEvent.click(getByRole("button", { name: "Open composer tools" }));
		await fireEvent.click(getByRole("menuitem", { name: "Atlas report" }));
		await fireEvent.click(
			within(getByRole("listbox", { name: "Atlas profile" })).getByRole(
				"option",
				{ name: "Overview" },
			),
		);
		await fireEvent.click(getByRole("button", { name: "Remove Atlas" }));
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Just chat" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(queryByText("Overview · ~2-5 min")).toBeNull();
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Just chat",
				atlasMode: false,
				atlasProfile: null,
			}),
		);
	});

	it("opens the command tray for a slash command when the registry flag is enabled", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "/" },
		});

		expect(
			getByRole("listbox", { name: "Composer commands" }),
		).toBeInTheDocument();
		expect(getByRole("option", { name: /\/model/i })).toBeInTheDocument();
	});

	it("keeps the command tray mounted in a closing state on Escape", async () => {
		const { getByPlaceholderText, getByRole, queryByRole } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/" } });
		expect(getByRole("listbox", { name: "Composer commands" })).toHaveAttribute(
			"data-state",
			"open",
		);

		await fireEvent.keyDown(input, { key: "Escape" });

		expect(getByRole("listbox", { name: "Composer commands" })).toHaveAttribute(
			"data-state",
			"closing",
		);

		await fireEvent.animationEnd(
			getByRole("listbox", { name: "Composer commands" }),
		);

		expect(queryByRole("listbox", { name: "Composer commands" })).toBeNull();
	});

	it("selects /web before sending a one-turn Web search", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/web" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(sendSpy).not.toHaveBeenCalled();
		expect(input.value).toBe("");

		await fireEvent.input(input, { target: { value: "Find the latest docs" } });
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Find the latest docs",
				forceWebSearch: true,
			}),
		);
	});

	it("toggles thinking off via /think and sends the updated toggle", async () => {
		const sendSpy = vi.fn();
		const reasoningDepthChangeSpy = vi.fn();
		const { getByPlaceholderText, getByRole, rerender } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
			reasoningDepth: "thorough",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/think" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		// /think no longer opens a picker (ADR-0061) — it flips the toggle
		// directly and clears the composer input.
		expect(input.value).toBe("");
		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("quick");

		await rerender({
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
			reasoningDepth: "quick",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		await fireEvent.input(input, {
			target: { value: "Answer quickly" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Answer quickly",
				reasoningDepth: "quick",
			}),
		);
	});

	it("still honors the legacy /depth alias, hidden from the browsable tray", async () => {
		const reasoningDepthChangeSpy = vi.fn();
		const { getByPlaceholderText, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			reasoningDepth: "thorough",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		// Typing a partial prefix never surfaces the alias.
		await fireEvent.input(input, { target: { value: "/dep" } });
		expect(queryByRole("option", { name: /\/depth/i })).toBeNull();

		// Typed out in full, it still resolves and flips the toggle.
		await fireEvent.input(input, { target: { value: "/depth" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(input.value).toBe("");
		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("quick");
	});

	it("sets thinking on/off explicitly via /quick and /thorough", async () => {
		const reasoningDepthChangeSpy = vi.fn();
		const { getByPlaceholderText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			reasoningDepth: "thorough",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/quick" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("quick");

		await fireEvent.input(input, { target: { value: "/thorough" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("thorough");
	});

	it("opens $ skill discovery mode from /skill instead of a coming-soon message", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/skill" } });
		await fireEvent.click(getByRole("option", { name: /\/skill/i }));

		expect(input.value).toBe("$");
		await waitFor(() => {
			expect(discoverSkillsMock).toHaveBeenCalled();
		});
	});

	it("starts a new conversation via /new", async () => {
		const { getByPlaceholderText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/new" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		await waitFor(() => {
			expect(gotoMock).toHaveBeenCalledWith("/");
		});
	});

	// Reviewer report — "I want /remember to be a feature" opened the command
	// tray, and Enter then saved a memory note instead of sending the
	// sentence. A slash only starts a command at the very start of the
	// composer text.
	it("treats a slash command typed mid-sentence as ordinary text", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByRole } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				onSend: sendSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: "I want /remember to be a feature" },
		});

		expect(queryByRole("listbox", { name: "Composer commands" })).toBeNull();

		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		expect(addMemoryNoteMock).not.toHaveBeenCalled();
		expect(input.value).toBe("I want /remember to be a feature");

		await fireEvent.click(getByRole("button", { name: "Send message" }));
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "I want /remember to be a feature",
			}),
		);
	});

	it("still opens the tray for a slash command that opens the composer text", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/remember oat milk" } });

		expect(
			getByRole("listbox", { name: "Composer commands" }),
		).toBeInTheDocument();

		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(input.value).toBe("");
		await waitFor(() => {
			expect(addMemoryNoteMock).toHaveBeenCalledWith("oat milk");
		});
	});

	it("saves a note via /remember and prompts for text when none is typed", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		// No note text yet: selecting it is a no-op with a hint, not a save.
		await fireEvent.input(input, { target: { value: "/remember" } });
		await fireEvent.click(getByRole("option", { name: /\/remember/i }));
		expect(addMemoryNoteMock).not.toHaveBeenCalled();
		expect(input.value).toBe("/remember");

		await fireEvent.input(input, {
			target: { value: "/remember I prefer dark mode" },
		});
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(input.value).toBe("");
		await waitFor(() => {
			expect(addMemoryNoteMock).toHaveBeenCalledWith("I prefer dark mode");
		});
	});

	it("downloads the conversation as Markdown via /export", async () => {
		const { getByPlaceholderText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			conversationId: "conv-1",
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/export" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		await waitFor(() => {
			expect(fetchConversationMarkdownExportMock).toHaveBeenCalledWith(
				"conv-1",
			);
		});
		await waitFor(() => {
			expect(saveBlobAsDownloadMock).toHaveBeenCalledWith(
				expect.any(Blob),
				"conversation.md",
			);
		});
	});

	it("reports a command to analytics once, with the conversation id, only when it runs", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			conversationId: "conv-1",
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		// A required-argument no-op is never counted.
		await fireEvent.input(input, { target: { value: "/remember" } });
		await fireEvent.click(getByRole("option", { name: /\/remember/i }));
		expect(recordComposerCommandUsedMock).not.toHaveBeenCalled();

		await fireEvent.input(input, {
			target: { value: "/remember I prefer dark mode" },
		});
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(recordComposerCommandUsedMock).toHaveBeenCalledTimes(1);
		expect(recordComposerCommandUsedMock).toHaveBeenCalledWith(
			"remember",
			"conv-1",
		);
	});

	it("reports /skill discovery to analytics with the conversation id", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			conversationId: "conv-1",
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/skill" } });
		await fireEvent.click(getByRole("option", { name: /\/skill/i }));

		expect(recordComposerCommandUsedMock).toHaveBeenCalledWith(
			"skill",
			"conv-1",
		);
	});

	it("shows the /document and /remember argument placeholders in the tray", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/document" } });
		expect(getByRole("option", { name: /\/document/i })).toHaveTextContent(
			"Search library documents",
		);

		await fireEvent.input(input, { target: { value: "/remember" } });
		expect(getByRole("option", { name: /\/remember/i })).toHaveTextContent(
			"What should I remember?",
		);
	});

	it("localizes the argument placeholders with the rest of the tray", async () => {
		uiLanguage.set("hu");
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText("Írj üzenetet...");

		await fireEvent.input(input, { target: { value: "/remember" } });
		expect(getByRole("option", { name: /\/remember/i })).toHaveTextContent(
			"Mire emlékezzek?",
		);
	});

	it("runs the /compact command without sending a chat message", async () => {
		const sendSpy = vi.fn();
		const compactSpy = vi.fn();
		const { getByPlaceholderText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
			onCompact: compactSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/compact" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(sendSpy).not.toHaveBeenCalled();
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("");
	});

	it("clears the Web search force flag after sending", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/web" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		await fireEvent.input(input, {
			target: { value: "Find current release notes" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		await fireEvent.input(input, { target: { value: "No search this time" } });
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ forceWebSearch: true }),
		);
		expect(sendSpy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ forceWebSearch: false }),
		);
	});

	it("announces the active command row while navigating the tray", async () => {
		// Addressed by test id, not by role: the composer now carries a second
		// polite region for extraction status, and `getByRole("status")` would
		// be ambiguous rather than wrong.
		const { getByPlaceholderText, getByTestId } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/" } });

		expect(getByTestId("composer-command-announcer")).toHaveTextContent(
			"Active command: /model Model",
		);
		await fireEvent.keyDown(input, { key: "ArrowDown" });

		expect(getByTestId("composer-command-announcer")).toHaveTextContent(
			"Active command: /style Style",
		);
	});

	it("scrolls the active slash command option into view while navigating the tray with arrow keys", async () => {
		const { spy, restore } = spyOnScrollIntoView();
		try {
			const { getByPlaceholderText, getByRole } = render(MessageInput, {
				composerCommandRegistryEnabled: true,
			});
			const input = getByPlaceholderText(
				"Type a message...",
			) as HTMLTextAreaElement;

			await fireEvent.input(input, { target: { value: "/" } });
			spy.mockClear();
			await fireEvent.keyDown(input, { key: "ArrowDown" });

			expect(getByRole("option", { name: /\/style/i })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			expect(spy).toHaveBeenCalledWith({
				block: "nearest",
				inline: "nearest",
			});

			spy.mockClear();
			await fireEvent.keyDown(input, { key: "ArrowUp" });

			expect(getByRole("option", { name: /\/model/i })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			expect(spy).toHaveBeenCalledWith({
				block: "nearest",
				inline: "nearest",
			});
		} finally {
			restore();
		}
	});

	it("consumes only the active command token and preserves surrounding text", async () => {
		const { getByPlaceholderText } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: "/web now please" },
		});
		input.setSelectionRange(4, 4);
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(input.value).toBe(" now please");
	});

	it("opens dollar skill discovery without triggering on prices", async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
				description: "Practice interview answers.",
				activationExamples: ["interview me"],
				enabled: true,
			},
		]);
		const { getByPlaceholderText, queryByRole, findByRole } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "It costs $12" } });
		expect(queryByRole("listbox", { name: "Composer commands" })).toBeNull();

		await fireEvent.input(input, { target: { value: "$interview" } });
		expect(
			await findByRole("option", { name: /Interview coach/i }),
		).toBeInTheDocument();
		expect(discoverSkillsMock).toHaveBeenCalledWith("interview");
	});

	it("scrolls the active skill discovery option into view while navigating the tray", async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
				description: "Practice interview answers.",
				activationExamples: [],
				enabled: true,
			},
			{
				id: "skill-2",
				ownership: "user",
				displayName: "Research planner",
				description: "Plan source-backed research.",
				activationExamples: [],
				enabled: true,
			},
		]);
		const { spy, restore } = spyOnScrollIntoView();
		try {
			const { getByPlaceholderText, findByRole } = render(MessageInput, {
				composerCommandRegistryEnabled: true,
			});
			const input = getByPlaceholderText(
				"Type a message...",
			) as HTMLTextAreaElement;

			await fireEvent.input(input, { target: { value: "$research" } });
			await findByRole("option", { name: /Interview coach/i });
			spy.mockClear();
			await fireEvent.keyDown(input, { key: "ArrowDown" });

			expect(
				await findByRole("option", { name: /Research planner/i }),
			).toHaveAttribute("aria-selected", "true");
			expect(spy).toHaveBeenCalledWith({
				block: "nearest",
				inline: "nearest",
			});
		} finally {
			restore();
		}
	});

	it("selects a discovered skill into pending state and preserves surrounding text", async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
				description: "Practice interview answers.",
				activationExamples: ["interview me"],
				enabled: true,
			},
		]);
		const sendSpy = vi.fn();
		const draftSpy = vi.fn();
		const { getByPlaceholderText, findByRole, getByRole, getByText } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				onSend: sendSpy,
				onDraftChange: draftSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: "Please $interview this answer" },
		});
		input.setSelectionRange(17, 17);
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.click(
			await findByRole("option", { name: /Interview coach/i }),
		);

		expect(input.value).toBe("Please  this answer");
		expect(getByText("Interview coach")).toBeInTheDocument();
		// Chips redesign: the five per-feature lists became ONE row, and the
		// "USER SKILL" eyebrow became a sparkle. Kind is asserted on the chip
		// itself rather than on shouted text that no longer exists.
		const chipRow = getByRole("list", { name: "Attached to this message" });
		expect(within(chipRow).getByTestId("composer-chip-skill")).toBeDefined();
		expect(
			within(chipRow).getByTestId("composer-chip-skill").dataset.chipKind,
		).toBe("skill");
		expect(within(chipRow).queryByTestId("composer-chip-linked")).toBeNull();
		expect(draftSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				pendingSkill: expect.objectContaining({
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				}),
			}),
		);

		await fireEvent.click(getByRole("button", { name: "Send message" }));
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Please  this answer",
				pendingSkill: expect.objectContaining({
					id: "skill-1",
					ownership: "user",
				}),
			}),
		);
	});

	it("shows variant kind and pack identity in skill discovery and send payloads", async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				baseSkillId: "system:research",
				baseSkillDisplayName: "Research Pack",
				displayName: "Research Pack, concise",
				description: "Use concise answers.",
				activationExamples: ["research concise"],
				enabled: true,
			},
		]);
		const sendSpy = vi.fn();
		const { getByPlaceholderText, findByRole, getByRole } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				onSend: sendSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: "$research Summarize this" },
		});
		input.setSelectionRange(9, 9);
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(
			await findByRole("option", {
				name: /Skill Variant Research Pack, concise Use concise answers.*Based on Research Pack/i,
			}),
		).toBeInTheDocument();
		await fireEvent.click(
			await findByRole("option", { name: /Research Pack, concise/i }),
		);

		const chipRow = getByRole("list", { name: "Attached to this message" });
		expect(within(chipRow).getByTestId("composer-chip-skill")).toBeDefined();
		expect(chipRow).toHaveTextContent("Research Pack, concise");
		await fireEvent.click(getByRole("button", { name: "Send message" }));
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				pendingSkill: expect.objectContaining({
					id: "variant-1",
					skillKind: "skill_variant",
					baseSkillId: "system:research",
					baseSkillDisplayName: "Research Pack",
				}),
			}),
		);
	});

	it("replaces the existing pending skill when another skill is selected", async () => {
		discoverSkillsMock
			.mockResolvedValueOnce([
				{
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
					description: "Practice interview answers.",
					activationExamples: [],
					enabled: true,
				},
			])
			.mockResolvedValueOnce([
				{
					id: "system:code-review",
					ownership: "system",
					displayName: "Code Review",
					description: "Review code.",
					activationExamples: [],
					enabled: true,
					published: true,
				},
			]);
		const { getByPlaceholderText, findByRole, queryByText, getByText } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "$interview First" } });
		input.setSelectionRange(10, 10);
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.click(
			await findByRole("option", { name: /Interview coach/i }),
		);
		expect(getByText("Interview coach")).toBeInTheDocument();

		await fireEvent.input(input, { target: { value: "$review First" } });
		input.setSelectionRange(7, 7);
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.click(await findByRole("option", { name: /Code Review/i }));

		expect(queryByText("Interview coach")).toBeNull();
		expect(getByText("Code Review")).toBeInTheDocument();
	});

	it("restores a pending skill draft chip without reopening discovery", () => {
		const { getByText, getByRole, queryByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			draftPendingSkill: {
				id: "skill-1",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Interview coach",
				baseSkillId: "system:interview",
				baseSkillDisplayName: "Interview Pack",
			},
			draftVersion: 1,
		});

		expect(getByText("Interview coach")).toBeInTheDocument();
		const chipRow = getByRole("list", { name: "Attached to this message" });
		expect(within(chipRow).getByTestId("composer-chip-skill")).toBeDefined();
		expect(chipRow).toHaveTextContent("Interview coach");
		expect(
			getByRole("button", { name: "Remove pending skill Interview coach" }),
		).toBeInTheDocument();
		expect(queryByRole("listbox", { name: "Composer commands" })).toBeNull();
	});

	it("ignores linked source and pending skill drafts when the registry flag is disabled", async () => {
		const sendSpy = vi.fn();
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByText } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: false,
				draftLinkedSources: [
					{
						displayArtifactId: "display-disabled",
						promptArtifactId: "prompt-disabled",
						familyArtifactIds: ["display-disabled", "prompt-disabled"],
						name: "Disabled source.pdf",
						type: "document",
					},
				],
				draftPendingSkill: {
					id: "skill-disabled",
					ownership: "user",
					displayName: "Disabled Skill",
				},
				draftVersion: 1,
				onDraftChange: draftSpy,
				onSend: sendSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		expect(queryByText("Disabled source.pdf")).toBeNull();
		expect(queryByText("Disabled Skill")).toBeNull();
		await waitFor(() =>
			expect(draftSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					selectedLinkedSources: [],
					pendingSkill: null,
				}),
			),
		);

		await fireEvent.input(input, {
			target: { value: "Send without disabled draft state" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Send without disabled draft state",
				linkedSources: [],
				pendingSkill: null,
			}),
		);
	});

	it("keeps pending composer state when /clear confirmation is cancelled", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByText, getByRole, findByText } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				draftText: "Keep this draft",
				draftAttachments: [
					{
						artifact: {
							id: "artifact-draft-clear",
							type: "source_document",
							retrievalClass: "durable",
							name: "clear-attachment.pdf",
							mimeType: "application/pdf",
							sizeBytes: 7,
							conversationId: "conv-1",
							summary: null,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						},
						promptReady: true,
						promptArtifactId: "normalized-clear-attachment",
						readinessError: null,
					},
				],
				draftLinkedSources: [
					{
						displayArtifactId: "display-clear",
						promptArtifactId: "prompt-clear",
						familyArtifactIds: ["display-clear", "prompt-clear"],
						name: "Clear source.md",
						type: "document",
					},
				],
				draftPendingSkill: {
					id: "skill-clear",
					ownership: "user",
					displayName: "Clear Skill",
				},
				draftVersion: 1,
				onDraftChange: draftSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		expect(await findByText("clear-attachment.pdf")).toBeInTheDocument();
		await fireEvent.input(input, {
			target: { value: "/clear Keep this draft" },
		});
		input.setSelectionRange("/clear".length, "/clear".length);
		await fireEvent.select(input);
		await fireEvent.click(getByRole("option", { name: /\/clear/i }));

		expect(confirmSpy).toHaveBeenCalledWith(
			"Clear the current draft and pending composer selections?",
		);
		expect(input.value).toBe("/clear Keep this draft");
		expect(getByText("clear-attachment.pdf")).toBeInTheDocument();
		expect(getByText("Clear source.md")).toBeInTheDocument();
		expect(getByText("Clear Skill")).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Remove pending skill Clear Skill" }),
		).toBeInTheDocument();
		expect(draftSpy).not.toHaveBeenLastCalledWith(
			expect.objectContaining({
				draftText: "",
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: null,
			}),
		);

		confirmSpy.mockRestore();
	});

	it("clears pending composer state after /clear confirmation", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByText } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				draftText: "Remove this draft",
				draftLinkedSources: [
					{
						displayArtifactId: "display-remove",
						promptArtifactId: "prompt-remove",
						familyArtifactIds: ["display-remove", "prompt-remove"],
						name: "Remove source.md",
						type: "document",
					},
				],
				draftPendingSkill: {
					id: "skill-remove",
					ownership: "system",
					displayName: "Remove Skill",
				},
				draftVersion: 1,
				onDraftChange: draftSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, {
			target: { value: "/clear Remove this draft" },
		});
		input.setSelectionRange("/clear".length, "/clear".length);
		await fireEvent.select(input);
		await fireEvent.click(getByRole("option", { name: /\/clear/i }));

		expect(confirmSpy).toHaveBeenCalledWith(
			"Clear the current draft and pending composer selections?",
		);
		expect(input.value).toBe("");
		expect(queryByText("Remove source.md")).toBeNull();
		expect(queryByText("Remove Skill")).toBeNull();
		expect(draftSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				draftText: "",
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: null,
			}),
		);

		confirmSpy.mockRestore();
	});

	// Everyday redesign, Direction B: thinking stays on the bar (it is one of
	// the three reached for mid-sentence). On is the glyph in the accent and
	// nothing else — no disc behind it, no dot under it — with a label that
	// says the control AND its state.
	it("shows the thinking toggle in the toolbar reflecting the current reasoningDepth", () => {
		const { getByTestId } = render(MessageInput, {
			reasoningDepth: "thorough",
		});

		const toggle = getByTestId("thinking-bar-toggle");
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(toggle).toHaveAttribute("title", "Thinking — on for this message");
		expect(toggle).toHaveClass("composer-face--on");
	});

	it("shows Thinking off styling when reasoningDepth is quick", () => {
		const { getByTestId } = render(MessageInput, {
			reasoningDepth: "quick",
		});

		const toggle = getByTestId("thinking-bar-toggle");
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(toggle).toHaveAttribute("title", "Think before answering");
		expect(toggle).not.toHaveClass("composer-face--on");
	});

	it("hides the thinking toggle when the selected model does not support reasoning controls", async () => {
		selectedModel.set("provider:p1:no-thinking");
		fetchAvailableModelsMock.mockResolvedValueOnce({
			providers: [
				{
					id: "p1",
					name: "p1",
					displayName: "Provider 1",
					iconAssetId: null,
					iconUrl: null,
					processingRegionCode: null,
					privacyPolicyUrl: null,
					models: [
						{
							id: "provider:p1:no-thinking",
							displayName: "No Thinking Model",
							iconUrl: null,
							guideNoteEn: null,
							guideNoteHu: null,
							guideBadge: null,
							guideNoCost: false,
							estimatedTokensPerSecond: null,
							maxModelContext: null,
							inputUsdMicrosPer1m: 0,
							outputUsdMicrosPer1m: 0,
							supportsReasoningControls: false,
						},
					],
				},
			],
		});

		const { queryByTestId } = render(MessageInput, {
			reasoningDepth: "thorough",
		});

		await waitFor(() => {
			expect(queryByTestId("thinking-bar-toggle")).toBeNull();
		});
	});

	it("sends the selected Reasoning depth with the next message", async () => {
		const sendSpy = vi.fn();
		const reasoningDepthChangeSpy = vi.fn();
		const { getByPlaceholderText, getByRole, getByTestId, rerender } = render(
			MessageInput,
			{
				onSend: sendSpy,
				reasoningDepth: "thorough",
				onReasoningDepthChange: reasoningDepthChangeSpy,
			},
		);

		await fireEvent.click(getByTestId("thinking-bar-toggle"));

		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("quick");

		await rerender({
			onSend: sendSpy,
			reasoningDepth: "quick",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Answer directly" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Answer directly",
				reasoningDepth: "quick",
			}),
		);
	});

	it("clears stale conversation ids when the parent resets the prop to null", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByLabelText, rerender } = render(
			MessageInput,
			{
				conversationId: "conv-stale",
				onSend: sendSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const button = getByLabelText("Send message") as HTMLButtonElement;

		await rerender({
			conversationId: null,
			onSend: sendSpy,
		});

		await fireEvent.input(input, { target: { value: "Fresh message" } });
		await fireEvent.click(button);

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Fresh message",
				conversationId: null,
			}),
		);
	});

	it("dispatches send event and clears input on Ctrl+Enter", async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			onSend: mockSend,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "Hello World" } });
		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith("Hello World");
		expect(input.value).toBe("");
	});

	it("does not send on plain Enter, but dispatches send from the current textarea value on Ctrl+Enter", async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			onSend: mockSend,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		input.value = "Hello from plain Enter";
		const notPrevented = await fireEvent.keyDown(input, {
			key: "Enter",
			shiftKey: false,
		});

		// A plain Enter keydown must fall through to the textarea's own
		// newline-insertion default — so the (cancelable) event must NOT be
		// prevented, and send must not be called.
		expect(notPrevented).toBe(true);
		expect(mockSend).not.toHaveBeenCalled();
		expect(input.value).toBe("Hello from plain Enter");

		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith("Hello from plain Enter");
		await waitFor(() => expect(input.value).toBe(""));
	});

	it("inserts newline but does not send on shift+enter", async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			onSend: mockSend,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "Line 1\nLine 2" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

		expect(mockSend).not.toHaveBeenCalled();
		expect(input.value).toBe("Line 1\nLine 2");
	});

	it("does not send if input is only whitespace", async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText, getByLabelText } = render(
			MessageInputWrapper,
			{ onSend: mockSend },
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const button = getByLabelText("Send message") as HTMLButtonElement;

		await fireEvent.input(input, { target: { value: "   \n  " } });

		expect(button.disabled).toBe(true);

		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("blocks send when over the max length", async () => {
		const maxLength = 10;
		const mockSend = vi.fn();
		const { getByPlaceholderText, getByLabelText } = render(
			MessageInputWrapper,
			{ maxLength, onSend: mockSend },
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const button = getByLabelText("Send message") as HTMLButtonElement;

		await fireEvent.input(input, { target: { value: "123456789" } });
		expect(button.disabled).toBe(false);

		await fireEvent.input(input, { target: { value: "12345678901" } });
		expect(button.disabled).toBe(true);

		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("does not expose task steering controls in the context ring popup", async () => {
		const steerSpy = vi.fn();
		const { getByLabelText, queryByRole, queryByText } = render(
			MessageInputWrapper,
			{
				onSteer: steerSpy,
				contextStatus: {
					conversationId: "conv-1",
					userId: "user-1",
					estimatedTokens: 1200,
					promptTokens: 1200,
					promptTokensSource: "estimated",
					maxContextTokens: 262144,
					thresholdTokens: 209715,
					targetTokens: 157286,
					compactionApplied: false,
					compactionMode: "none",
					routingStage: "deterministic",
					routingConfidence: 0,
					verificationStatus: "skipped",
					layersUsed: [],
					workingSetCount: 0,
					workingSetArtifactIds: [],
					workingSetApplied: false,
					taskStateApplied: false,
					promptArtifactCount: 0,
					recentTurnCount: 0,
					summary: null,
					updatedAt: Date.now(),
				},
				contextDebug: {
					activeTaskId: null,
					activeTaskObjective: "Current task",
					taskLocked: false,
					routingStage: "deterministic",
					routingConfidence: 0,
					verificationStatus: "skipped",
					selectedEvidence: [],
					selectedEvidenceBySource: [],
					pinnedEvidence: [],
					excludedEvidence: [],
				},
			},
		);

		await fireEvent.click(getByLabelText(/context window usage/i));

		expect(queryByText("Current task")).toBeNull();
		expect(queryByRole("button", { name: "Lock task" })).toBeNull();
		expect(queryByRole("button", { name: "Start new task" })).toBeNull();
		expect(steerSpy).not.toHaveBeenCalled();
	});

	it("opens context source management from the context ring popup", async () => {
		const manageEvidenceSpy = vi.fn();
		const { getByLabelText, getByRole } = render(MessageInputWrapper, {
			onManageEvidence: manageEvidenceSpy,
			contextStatus: {
				conversationId: "conv-1",
				userId: "user-1",
				estimatedTokens: 1200,
				promptTokens: 1200,
				promptTokensSource: "estimated",
				maxContextTokens: 262144,
				thresholdTokens: 209715,
				targetTokens: 157286,
				compactionApplied: false,
				compactionMode: "none",
				routingStage: "deterministic",
				routingConfidence: 0,
				verificationStatus: "skipped",
				layersUsed: [],
				workingSetCount: 0,
				workingSetArtifactIds: [],
				workingSetApplied: false,
				taskStateApplied: false,
				promptArtifactCount: 0,
				recentTurnCount: 0,
				summary: null,
				updatedAt: Date.now(),
			},
			contextDebug: {
				activeTaskId: null,
				activeTaskObjective: "Current task",
				taskLocked: false,
				routingStage: "deterministic",
				routingConfidence: 0,
				verificationStatus: "skipped",
				selectedEvidence: [],
				selectedEvidenceBySource: [],
				pinnedEvidence: [],
				excludedEvidence: [],
			},
		});

		await fireEvent.click(getByLabelText(/context window usage/i));
		await fireEvent.click(
			getByRole("button", { name: "Manage context sources" }),
		);

		expect(manageEvidenceSpy).toHaveBeenCalledTimes(1);
	});

	it("disables send while an attachment upload is still in progress", async () => {
		const sendSpy = vi.fn();
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByLabelText, getByText } =
			render(MessageInput, {
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onSend: sendSpy,
				onUploadFiles: uploadFilesHandler,
			});

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const sendButton = getByLabelText("Send message") as HTMLButtonElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		await fireEvent.input(textarea, { target: { value: "Use this file" } });
		expect(sendButton.disabled).toBe(false);

		const file = new File(["hello"], "recipe.txt", { type: "text/plain" });
		await fireEvent.change(fileInput, { target: { files: [file] } });

		await waitFor(() => {
			expect(getByText("Uploading file...")).toBeDefined();
			expect(sendButton.disabled).toBe(true);
		});

		// Simulate page completing the upload
		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "recipe.txt",
					mimeType: "text/plain",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: "Dinner recipe",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "normalized-1",
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(sendButton.disabled).toBe(false);
		});
		expect(sendSpy).not.toHaveBeenCalled();
	});

	it("queues send intent on Ctrl+Enter while attachment processing is running and auto-sends when ready", async () => {
		const sendSpy = vi.fn();
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByText } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onSend: sendSpy,
				onUploadFiles: uploadFilesHandler,
			},
		);

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		await fireEvent.input(textarea, { target: { value: "Send when ready" } });
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "notes.pdf", { type: "application/pdf" })],
			},
		});

		await waitFor(() => {
			expect(getByText("Uploading file...")).toBeDefined();
		});

		await fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

		await waitFor(() => {
			expect(
				getByText(
					"Message will send automatically when file processing finishes.",
				),
			).toBeDefined();
		});

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-auto-send-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "notes.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: "OCR me",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "normalized-auto-send-1",
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(sendSpy).toHaveBeenCalledTimes(1);
		});
		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Send when ready" }),
		);
	});

	it("blocks send when an uploaded attachment is not prompt-ready", async () => {
		const sendSpy = vi.fn();
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByLabelText, findByText } =
			render(MessageInput, {
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onSend: sendSpy,
				onUploadFiles: uploadFilesHandler,
			});

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const sendButton = getByLabelText("Send message") as HTMLButtonElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		await fireEvent.input(textarea, { target: { value: "Use this file" } });
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "scan.pdf", { type: "application/pdf" })],
			},
		});

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-2",
					type: "source_document",
					retrievalClass: "durable",
					name: "scan.pdf",
					mimeType: "application/pdf",
					sizeBytes: 128,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: false,
				promptArtifactId: null,
				readinessError: "This file could not be prepared for chat.",
			},
		});

		expect(
			await findByText(
				/scan\.pdf: This file could not be prepared for chat\./i,
			),
		).toBeDefined();
		expect(sendButton.disabled).toBe(true);

		await fireEvent.click(sendButton);
		expect(sendSpy).not.toHaveBeenCalled();
	});

	// The server's readiness sentence is English whatever the user's language
	// is. It now travels with a code beside it, and THAT is what the composer
	// renders — otherwise a Hungarian user reads Hungarian chips above an
	// English refusal.
	it("renders the readiness refusal in the user's language, from its code", async () => {
		uiLanguage.set("hu");
		try {
			let doneCallback: ((result: UploadDoneResult) => void) | null = null;
			const { container, findByText } = render(MessageInput, {
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onUploadFiles: (payload: UploadFilesPayload) => {
					doneCallback = payload.done;
				},
			});
			const fileInput = container.querySelector(
				'input[type="file"]',
			) as HTMLInputElement;
			await fireEvent.change(fileInput, {
				target: {
					files: [new File(["scan"], "scan.pdf", { type: "application/pdf" })],
				},
			});

			completeUpload(doneCallback, {
				success: true,
				attachment: {
					artifact: {
						id: "artifact-hu",
						type: "source_document",
						retrievalClass: "durable",
						name: "scan.pdf",
						mimeType: "application/pdf",
						sizeBytes: 128,
						conversationId: "conv-1",
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					promptReady: false,
					promptArtifactId: null,
					readinessError:
						"This file could not be prepared for chat. Supported extraction currently works best for text.",
					readinessErrorCode: "not_prepared",
				},
			});

			const line = await findByText(/scan\.pdf: Ezt a fájlt nem sikerült/i);
			expect(line).toBeDefined();
			expect(line.textContent).not.toContain("could not be prepared");
		} finally {
			uiLanguage.set("en");
		}
	});

	// A server that predates the codes still has to say something specific.
	it("falls back to the server sentence when no code came with it", async () => {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const { container, findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: (payload: UploadFilesPayload) => {
				doneCallback = payload.done;
			},
		});
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["old"], "legacy.pdf", { type: "application/pdf" })],
			},
		});

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-legacy",
					type: "source_document",
					retrievalClass: "durable",
					name: "legacy.pdf",
					mimeType: "application/pdf",
					sizeBytes: 128,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: false,
				promptArtifactId: null,
				readinessError: "Something specific the old server said.",
			},
		});

		expect(
			await findByText(
				/legacy\.pdf: Something specific the old server said\./i,
			),
		).toBeDefined();
	});

	it("emits onUploadFiles with all selected files from one picker action", async () => {
		const uploadFilesSpy = vi.fn();
		const { container, findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const firstFile = new File(["first"], "first.txt", { type: "text/plain" });
		const secondFile = new File(["second"], "second.txt", {
			type: "text/plain",
		});

		await fireEvent.change(fileInput, {
			target: { files: [firstFile, secondFile] },
		});

		expect(uploadFilesSpy).toHaveBeenCalledTimes(1);
		const payload = uploadFilesSpy.mock.calls[0][0];
		expect(payload.files).toHaveLength(2);
		expect(payload.files[0].name).toBe("first.txt");
		expect(payload.files[1].name).toBe("second.txt");

		// Simulate both uploads completing via done callback
		payload.done({
			success: true,
			attachment: {
				artifact: {
					id: "artifact-multi-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "first.txt",
					mimeType: "text/plain",
					sizeBytes: 5,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "normalized-multi-1",
				readinessError: null,
			},
		});
		payload.done({
			success: true,
			attachment: {
				artifact: {
					id: "artifact-multi-2",
					type: "source_document",
					retrievalClass: "durable",
					name: "second.txt",
					mimeType: "text/plain",
					sizeBytes: 6,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "normalized-multi-2",
				readinessError: null,
			},
		});

		expect(await findByText("first.txt")).toBeDefined();
		expect(await findByText("second.txt")).toBeDefined();
	});

	it("ignores stale async draft emissions after send clears the composer", async () => {
		let resolveConversation: ((id: string) => void) | null = null;
		const ensureConversation = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveConversation = resolve;
				}),
		);
		const sendSpy = vi.fn();
		const draftSpy = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			ensureConversation,
			onSend: (message: string) =>
				sendSpy({
					message,
					attachmentIds: [],
					attachments: [],
					conversationId: null,
				}),
			onDraftChange: draftSpy,
		});

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "Race me" } });
		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		expect(sendSpy).toHaveBeenCalledWith({
			message: "Race me",
			attachmentIds: [],
			attachments: [],
			conversationId: null,
		});
		expect(draftSpy).toHaveBeenCalledTimes(1);
		expect(draftSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: null,
				draftText: "",
				selectedAttachmentIds: [],
			}),
		);

		const resolveDraftConversation = resolveConversation as unknown as
			| ((id: string) => void)
			| null;
		if (!resolveDraftConversation) {
			throw new Error("Draft conversation resolver was not registered.");
		}
		resolveDraftConversation("conv-race");
		await waitFor(() => {
			expect(ensureConversation).toHaveBeenCalledTimes(1);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(draftSpy).toHaveBeenCalledTimes(1);
	});

	it("does not create a draft conversation for raw command triggers", async () => {
		const ensureConversation = vi.fn(async () => "conv-command");
		const draftSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
			ensureConversation,
			onDraftChange: draftSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/" } });
		await waitFor(() =>
			expect(
				getByRole("listbox", { name: "Composer commands" }),
			).toBeInTheDocument(),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(ensureConversation).not.toHaveBeenCalled();

		await fireEvent.input(input, { target: { value: "$" } });
		await waitFor(() =>
			expect(
				getByRole("listbox", { name: "Composer commands" }),
			).toBeInTheDocument(),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(ensureConversation).not.toHaveBeenCalled();
	});

	it("queues the next message on Ctrl+Enter while generation is in progress", async () => {
		const queueSpy = vi.fn();
		const { getByPlaceholderText, queryByTestId } = render(
			MessageInputWrapper,
			{
				isGenerating: true,
				onQueue: queueSpy,
			},
		);

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "Queue this next" } });
		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		expect(queueSpy).toHaveBeenCalledTimes(1);
		expect(queueSpy).toHaveBeenCalledWith("Queue this next");
		expect(input.value).toBe("");
		expect(queryByTestId("queue-button")).toBeNull();
	});

	it("keeps queue available but hides Stop when the active turn cannot be stopped", async () => {
		const queueSpy = vi.fn();
		const stopSpy = vi.fn();
		const { getByPlaceholderText, getByTestId, queryByRole } = render(
			MessageInput,
			{
				isGenerating: true,
				canStopStreaming: false,
				onQueue: queueSpy,
				onStop: stopSpy,
			},
		);

		expect(queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "Queue this next" } });
		await fireEvent.click(getByTestId("queue-button"));

		expect(queueSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Queue this next" }),
		);
		expect(stopSpy).not.toHaveBeenCalled();
	});

	it("does not clear the draft when the queue slot is already occupied", async () => {
		const queueSpy = vi.fn();
		const { getByPlaceholderText } = render(MessageInputWrapper, {
			isGenerating: true,
			hasQueuedMessage: true,
			queuedMessagePreview: "Already queued",
			onQueue: queueSpy,
		});

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "Keep this draft" } });
		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		expect(queueSpy).not.toHaveBeenCalled();
		expect(input.value).toBe("Keep this draft");
	});

	it("allows deleting the queued message from the banner", async () => {
		const deleteSpy = vi.fn();
		const { getByTestId } = render(MessageInputWrapper, {
			hasQueuedMessage: true,
			queuedMessagePreview: "Already queued",
			onDeleteQueuedMessage: deleteSpy,
		});

		await fireEvent.click(getByTestId("delete-queued-button"));

		expect(deleteSpy).toHaveBeenCalledTimes(1);
	});

	it("emits onUploadFiles when files are picked via file picker", async () => {
		const uploadFilesSpy = vi.fn();
		const { container } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = new File(["hello"], "test.txt", { type: "text/plain" });

		await fireEvent.change(fileInput, { target: { files: [file] } });

		expect(uploadFilesSpy).toHaveBeenCalledTimes(1);
		expect(uploadFilesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				files: [file],
				conversationId: "conv-1",
			}),
		);
		expect(uploadFilesSpy.mock.calls[0][0].done).toBeInstanceOf(Function);
	});

	it("uses the registered upload handler to show progress for dropped files", async () => {
		let registeredUpload: ((files: FileList | null) => Promise<void>) | null =
			null;
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { findByText, queryByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadReady: (uploadFn: (files: FileList | null) => Promise<void>) => {
				registeredUpload = uploadFn;
			},
			onUploadFiles: uploadFilesHandler,
		});

		await waitFor(() => {
			expect(registeredUpload).toBeInstanceOf(Function);
		});
		const file = new File(["# dropped"], "dropped.md", {
			type: "text/markdown",
		});
		await getRegisteredUpload(registeredUpload)([file] as unknown as FileList);

		expect(uploadFilesHandler).toHaveBeenCalledTimes(1);
		expect(uploadFilesHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				files: [file],
				conversationId: "conv-1",
			}),
		);
		expect(await findByText("Uploading file...")).toBeDefined();

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-dropped",
					type: "source_document",
					retrievalClass: "durable",
					name: "dropped.md",
					mimeType: "text/markdown",
					sizeBytes: 9,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "artifact-dropped",
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(queryByText("Uploading file...")).toBeNull();
		});
		expect(await findByText("dropped.md")).toBeDefined();
	});

	it("adds attachment to list when done callback is called with success", async () => {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = new File(["content"], "report.pdf", {
			type: "application/pdf",
		});

		await fireEvent.change(fileInput, { target: { files: [file] } });

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "report.pdf",
					mimeType: "application/pdf",
					sizeBytes: 7,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "normalized-1",
				readinessError: null,
			},
		});

		expect(await findByText("report.pdf")).toBeDefined();
	});

	it("does not reselect already attached conversation artifacts in the composer", async () => {
		const { queryByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			attachedArtifacts: [
				{
					id: "artifact-sent",
					type: "source_document",
					retrievalClass: "durable",
					name: "already-sent.pdf",
					mimeType: "application/pdf",
					sizeBytes: 7,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			],
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(queryByText("already-sent.pdf")).toBeNull();
	});

	it("still restores explicitly saved draft attachments", async () => {
		const { findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			draftVersion: 1,
			draftAttachments: [
				{
					artifact: {
						id: "artifact-draft",
						type: "source_document",
						retrievalClass: "durable",
						name: "draft-attachment.pdf",
						mimeType: "application/pdf",
						sizeBytes: 7,
						conversationId: "conv-1",
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					promptReady: true,
					promptArtifactId: "normalized-draft",
					readinessError: null,
				},
			],
		});

		expect(await findByText("draft-attachment.pdf")).toBeDefined();
	});

	it("shows error when done callback is called with failure", async () => {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = new File(["broken"], "corrupt.pdf", {
			type: "application/pdf",
		});

		await fireEvent.change(fileInput, { target: { files: [file] } });

		completeUpload(doneCallback, {
			success: false,
			fileName: "corrupt.pdf",
			error: "Server rejected the file",
		});

		expect(
			await findByText("corrupt.pdf: Server rejected the file"),
		).toBeDefined();
	});

	it("rejects oversized file locally without emitting onUploadFiles", async () => {
		const uploadFilesSpy = vi.fn();
		const { container, findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const largeFile = new File(["x"], "huge.pdf", { type: "application/pdf" });
		Object.defineProperty(largeFile, "size", { value: 101 * 1024 * 1024 });

		await fireEvent.change(fileInput, { target: { files: [largeFile] } });

		expect(uploadFilesSpy).not.toHaveBeenCalled();
		expect(await findByText(/exceed.*100MB|exceed.*upload size/)).toBeDefined();
	});

	// The composer's limit is no longer a literal 100 MB: it is whatever the
	// server last reported, seeded by the SSR shell and refreshed by every
	// upload intent.
	it("takes the size limit from the store, not a hardcoded 100MB", async () => {
		setMaxFileUploadSize(10 * 1024 * 1024);
		const uploadFilesSpy = vi.fn();
		const { container, findByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesSpy,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		// Comfortably under the old 100 MB literal, over the reported limit.
		const file = new File(["x"], "mid.pdf", { type: "application/pdf" });
		Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 });

		await fireEvent.change(fileInput, { target: { files: [file] } });

		expect(uploadFilesSpy).not.toHaveBeenCalled();
		expect(await findByText(/10MB/)).toBeDefined();
	});

	it("publishes the chat accept list on its file input", async () => {
		// Before this, the composer's input had no `accept` at all, so the OS
		// picker offered every file on disk and the server refused it later.
		const { container } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
		});

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const accept = fileInput.getAttribute("accept") ?? "";

		expect(accept).toBe(getAcceptAttribute("chat"));
		expect(accept.split(",")).toContain(".pdf");
		expect(accept.split(",")).toContain(".py");
		// Rejected intake routes are offered nowhere.
		expect(accept.split(",")).not.toContain(".mp4");
		expect(accept.split(",")).not.toContain(".zip");
	});

	it("shows a waiting hint when send is blocked by an unready attachment", async () => {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByTestId } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onUploadFiles: uploadFilesHandler,
			},
		);

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		await fireEvent.input(input, { target: { value: "Use this file" } });
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "scan.pdf", { type: "application/pdf" })],
			},
		});

		// Upload is in flight → "Uploading file..." hint renders beside the send button.
		await waitFor(() => {
			expect(getByTestId("send-disabled-hint")).toHaveTextContent(
				"Uploading file...",
			);
		});

		// Simulate the file landing but still not prompt-ready (extracting).
		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-unready",
					type: "source_document",
					retrievalClass: "durable",
					name: "scan.pdf",
					mimeType: "application/pdf",
					sizeBytes: 128,
					conversationId: "conv-1",
					summary: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(getByTestId("send-disabled-hint")).toHaveTextContent(
				"Extracting document text… this can take up to ~10s for scanned PDFs.",
			);
		});
	});

	it("hides the disabled-send hint when the message is over-length", async () => {
		const uploadFilesHandler = vi.fn((_payload: UploadFilesPayload) => {});

		const { container, getByPlaceholderText, queryByTestId } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				maxLength: 10,
				onUploadFiles: uploadFilesHandler,
			},
		);

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		await fireEvent.input(input, { target: { value: "Over limit!" } });
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "scan.pdf", { type: "application/pdf" })],
			},
		});

		// Upload is in flight, but the over-length red counter takes priority
		// and no disabled-send hint is shown.
		await waitFor(() => {
			expect(queryByTestId("send-disabled-hint")).toBeNull();
		});
	});

	it("shows an always-visible over-length counter once the message exceeds maxLength (ADR-0043 14f)", async () => {
		const mockSend = vi.fn();
		const { getByPlaceholderText, getByTestId, getByLabelText } = render(
			MessageInputWrapper,
			{ maxLength: 10000, onSend: mockSend },
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const button = getByLabelText("Send message") as HTMLButtonElement;

		await fireEvent.input(input, { target: { value: "a".repeat(12043) } });

		expect(getByTestId("over-length-counter")).toHaveTextContent(
			"12,043 / 10,000 — too long to send",
		);
		expect(button.disabled).toBe(true);
	});

	it("hides the over-length counter when the message is within maxLength", async () => {
		const { getByPlaceholderText, queryByTestId } = render(
			MessageInputWrapper,
			{ maxLength: 10000 },
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "Well within range" } });

		expect(queryByTestId("over-length-counter")).toBeNull();
	});

	it("hides the disabled-send hint when send is enabled", async () => {
		const { getByPlaceholderText, queryByTestId } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "Hello" } });
		expect(queryByTestId("send-disabled-hint")).toBeNull();
	});

	it("focuses the composer when / is pressed outside a text field", async () => {
		localStorage.removeItem("alfyai:composer:slashHintDismissed");
		const { getByPlaceholderText } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		input.blur();

		await fireEvent.keyDown(document.body, { key: "/" });

		expect(document.activeElement).toBe(input);
	});

	it("does not steal focus when / is typed inside a text field", async () => {
		const { getByPlaceholderText } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const other = document.createElement("input");
		other.type = "text";
		document.body.appendChild(other);
		other.focus();

		await fireEvent.keyDown(other, { key: "/" });

		expect(document.activeElement).toBe(other);
		expect(input).not.toBe(document.activeElement);
		other.remove();
	});

	it("does not trigger the / shortcut with modifier keys", async () => {
		const { getByPlaceholderText } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		input.blur();

		await fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
		expect(document.activeElement).not.toBe(input);

		await fireEvent.keyDown(document.body, { key: "/", metaKey: true });
		expect(document.activeElement).not.toBe(input);
	});

	it("dismisses the slash-shortcut coach hint after the first focus", async () => {
		localStorage.removeItem("alfyai:composer:slashHintDismissed");
		const { getByPlaceholderText, queryByTestId } = render(MessageInput);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		input.blur();
		await tick();

		// Hint is visible before the composer is focused.
		expect(queryByTestId("slash-shortcut-hint")).not.toBeNull();

		// Pressing / focuses the composer, which dismisses the hint.
		await fireEvent.keyDown(document.body, { key: "/" });
		await tick();

		expect(queryByTestId("slash-shortcut-hint")).toBeNull();
	});
});

describe("MessageInput incognito toggle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
	});

	// Everyday redesign: incognito left the bar and lives in the "+" menu
	// only — it is a per-conversation decision, not a per-message one, so it
	// does not earn one of the three resting icons.
	it("is not on the resting bar", () => {
		const { queryByTestId } = render(MessageInput, {
			props: { conversationId: "conv-1", memoryIncognito: true },
		});
		expect(queryByTestId("incognito-toggle")).toBeNull();
	});

	it("reflects the conversation's stored incognito state", async () => {
		const { getByTestId } = render(MessageInput, {
			props: { conversationId: "conv-1", memoryIncognito: true },
		});
		await openComposerMenu(getByTestId);
		expect(getByTestId("incognito-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	it("persists the toggle for an existing conversation and raises the mask face", async () => {
		const { getByTestId, findByTestId, getByPlaceholderText } = render(
			MessageInput,
			{
				props: { conversationId: "conv-1", memoryIncognito: false },
			},
		);
		await openComposerMenu(getByTestId);

		const toggle = getByTestId("incognito-toggle");
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await fireEvent.click(toggle);

		await waitFor(() => {
			expect(setConversationMemoryIncognitoMock).toHaveBeenCalledWith(
				"conv-1",
				true,
			);
		});
		// The menu stays open: a switch row flips in place, so turning two
		// things on is one visit rather than two.
		expect(getByTestId("incognito-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		// Incognito redesign: the state shows as a fifth face on the bar and
		// in the placeholder — never as a notice row above the composer.
		await findByTestId("incognito-face");
		expect(
			getByPlaceholderText("Incognito · nothing here is remembered"),
		).toBeInTheDocument();
	});

	it("holds local state for a brand-new conversation with no id yet", async () => {
		const { getByTestId, findByTestId, getByPlaceholderText } = render(
			MessageInput,
			{
				props: { conversationId: null, memoryIncognito: false },
			},
		);
		await openComposerMenu(getByTestId);

		await fireEvent.click(getByTestId("incognito-toggle"));

		// No conversation id: nothing is persisted, but the UI reflects it —
		// the landing composer shows the face and placeholder like any chat.
		expect(setConversationMemoryIncognitoMock).not.toHaveBeenCalled();
		expect(getByTestId("incognito-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await findByTestId("incognito-face");
		expect(
			getByPlaceholderText("Incognito · nothing here is remembered"),
		).toBeInTheDocument();
	});
});

// ── Incognito redesign: the mask face, the placeholder and the card ──
//
// The old full-width accent notice above the composer is gone. While the
// flag is on, the action row grows a fifth face (a mask in ink), the empty
// textarea says what the mask means, and the face opens a small card with
// the same switch the "+" menu has.
describe("MessageInput incognito indicator", () => {
	let animateSpy: { mockRestore: () => void } | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		uiLanguage.set("en");
		selectedModel.set("model1");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		// The card plays an outro; jsdom has no Web Animations, so the block
		// that holds it would otherwise linger. Finish every animation at once
		// so "the face is gone" can be asserted on the DOM.
		if (!("animate" in Element.prototype)) {
			Object.defineProperty(Element.prototype, "animate", {
				configurable: true,
				writable: true,
				value: () => ({}),
			});
		}
		animateSpy = vi
			.spyOn(Element.prototype, "animate")
			.mockImplementation(() => {
				const animation = {
					finished: Promise.resolve(),
					cancel: vi.fn(),
					play: vi.fn(),
					onfinish: null as Animation["onfinish"],
				} as unknown as Animation;
				setTimeout(() => {
					animation.onfinish?.call(
						animation,
						new Event("finish") as AnimationPlaybackEvent,
					);
				}, 0);
				return animation;
			});
	});

	afterEach(() => {
		animateSpy?.mockRestore();
		animateSpy = null;
	});

	function renderIncognito(memoryIncognito = true) {
		return render(MessageInput, {
			props: { conversationId: "conv-1", memoryIncognito },
		});
	}

	it("draws nothing extra while incognito is off", () => {
		const { queryByTestId, getByPlaceholderText, queryByText } =
			renderIncognito(false);

		expect(queryByTestId("incognito-face")).toBeNull();
		expect(queryByTestId("incognito-popover")).toBeNull();
		expect(queryByText(/won't be saved to memory/i)).toBeNull();
		expect(getByPlaceholderText("Type a message...")).toBeInTheDocument();
	});

	it("shows the mask as a fifth face, in accent like the other active faces, with the incognito placeholder", () => {
		const { getByTestId, getByPlaceholderText, queryByText, queryByRole } =
			renderIncognito();

		const face = getByTestId("incognito-face");
		expect(face).toHaveClass("composer-face");
		expect(face).toHaveClass("composer-face--on");
		expect(face).toHaveAttribute("aria-label", "Incognito is on");
		expect(face).toHaveAttribute("aria-expanded", "false");
		// After thinking, before anything that is not a face.
		const bar = face.closest(".composer-bar");
		expect(bar).not.toBeNull();
		const faces = Array.from(
			(bar as HTMLElement).querySelectorAll(".composer-face"),
		);
		expect(faces.at(-1)).toBe(face);
		expect(faces.map((el) => el.getAttribute("data-testid"))).toEqual([
			"composer-tools-trigger",
			"attach-toggle",
			"connections-toggle",
			"thinking-bar-toggle",
			"incognito-face",
		]);

		expect(
			getByPlaceholderText("Incognito · nothing here is remembered"),
		).toBeInTheDocument();
		// The notice row is gone for good.
		expect(queryByText(/won't be saved to memory/i)).toBeNull();
		expect(queryByRole("status", { name: /incognito/i })).toBeNull();
	});

	it("uses the short placeholder on a phone", () => {
		const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 390,
		});
		try {
			const { getByPlaceholderText } = renderIncognito();
			expect(
				getByPlaceholderText("Incognito · not remembered"),
			).toBeInTheDocument();
		} finally {
			if (original) Object.defineProperty(window, "innerWidth", original);
		}
	});

	it("keeps the placeholder in Hungarian too", () => {
		uiLanguage.set("hu");
		const { getByPlaceholderText, getByTestId } = renderIncognito();
		expect(
			getByPlaceholderText("Inkognitó · itt semmi nem marad meg"),
		).toBeInTheDocument();
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-label",
			"Inkognitó bekapcsolva",
		);
	});

	it("opens a card from the face with the explanation and the same switch", async () => {
		const { getByTestId, queryByTestId } = renderIncognito();

		expect(queryByTestId("incognito-popover")).toBeNull();
		await fireEvent.click(getByTestId("incognito-face"));

		const popover = getByTestId("incognito-popover");
		expect(popover).toHaveAttribute("role", "dialog");
		expect(popover).toHaveAttribute("id", "incognito-popover");
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-controls",
			"incognito-popover",
		);
		expect(within(popover).getByText("Incognito is on")).toBeInTheDocument();
		expect(
			within(popover).getByText(
				"Nothing in this chat is remembered. Memory stays off for the whole conversation, and it is left out of your analytics.",
			),
		).toBeInTheDocument();

		const toggle = getByTestId("incognito-popover-toggle");
		expect(toggle).toHaveAttribute("role", "switch");
		expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(within(toggle).getByText("Incognito")).toBeInTheDocument();
		expect(toggle.querySelector(".switch-face--on")).not.toBeNull();
		// The switch takes focus, so Space and Escape have somewhere to land.
		await waitFor(() => expect(document.activeElement).toBe(toggle));
	});

	it("turning it off from the card persists, closes the card and removes the face", async () => {
		const { getByTestId, queryByTestId, getByPlaceholderText } =
			renderIncognito();

		await fireEvent.click(getByTestId("incognito-face"));
		await fireEvent.click(getByTestId("incognito-popover-toggle"));

		await waitFor(() => {
			expect(setConversationMemoryIncognitoMock).toHaveBeenCalledWith(
				"conv-1",
				false,
			);
		});
		await waitFor(() => {
			expect(queryByTestId("incognito-face")).toBeNull();
			expect(queryByTestId("incognito-popover")).toBeNull();
		});
		expect(getByPlaceholderText("Type a message...")).toBeInTheDocument();
		// Focus was on the switch, which has left the DOM with the face; it
		// lands on the textarea rather than falling to <body>.
		await waitFor(() =>
			expect(document.activeElement).toBe(getByTestId("message-input")),
		);
	});

	it("opening the card puts the plus menu away, and the plus menu puts the card away", async () => {
		const { getByTestId } = renderIncognito();

		// The menus outro through svelte/transition, which jsdom never finishes,
		// so the triggers' aria-expanded is what says which surface is open.
		await openComposerMenu(getByTestId);
		expect(getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await fireEvent.click(getByTestId("incognito-face"));
		await tick();
		expect(getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(getByTestId("incognito-popover")).toBeInTheDocument();

		await openComposerMenu(getByTestId);
		expect(getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("puts the face back when the server refuses the change", async () => {
		setConversationMemoryIncognitoMock.mockRejectedValueOnce(new Error("nope"));
		const { getByTestId, findByTestId } = renderIncognito();

		await fireEvent.click(getByTestId("incognito-face"));
		await fireEvent.click(getByTestId("incognito-popover-toggle"));

		await findByTestId("incognito-face");
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("closes on Escape and hands focus back to the face", async () => {
		const { getByTestId } = renderIncognito();

		await fireEvent.click(getByTestId("incognito-face"));
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"true",
		);

		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await tick();

		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(document.activeElement).toBe(getByTestId("incognito-face"));
	});

	it("closes on a press outside, and the switch in the plus menu closes it too", async () => {
		const { getByTestId } = renderIncognito();

		await fireEvent.click(getByTestId("incognito-face"));
		await fireEvent.mouseDown(document.body);
		await tick();
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"false",
		);

		// Reopen, then flip the flag from the menu: the card is about a state,
		// and goes with it.
		await fireEvent.click(getByTestId("incognito-face"));
		expect(getByTestId("incognito-face")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await openComposerMenu(getByTestId);
		await fireEvent.click(getByTestId("incognito-toggle"));
		await waitFor(() => {
			expect(setConversationMemoryIncognitoMock).toHaveBeenCalledWith(
				"conv-1",
				false,
			);
		});
		await waitFor(() => {
			expect(screen.queryByTestId("incognito-face")).toBeNull();
		});
	});

	it("reports the change so the sidebar can redraw its mark", async () => {
		const onMemoryIncognitoChange = vi.fn();
		const { getByTestId } = render(MessageInput, {
			props: {
				conversationId: "conv-1",
				memoryIncognito: true,
				onMemoryIncognitoChange,
			},
		});

		await fireEvent.click(getByTestId("incognito-face"));
		await fireEvent.click(getByTestId("incognito-popover-toggle"));

		await waitFor(() => {
			expect(onMemoryIncognitoChange).toHaveBeenCalledWith(false, "conv-1");
		});
	});
});

// ADR 0044 Decision 1 — the composer's per-capability toggle rows are
// replaced by a single per-conversation "Connections" master toggle. It maps
// to the existing `enabledConnectionCapabilities` payload field: on sends
// the user's default-on capability set, off sends []. Only rendered at all
// when the user has any served capabilities.
// Connections redesign — the plug OPENS the account list; the master switch
// inside it is what turns connections on and off. These fixtures return no
// per-account list, so that switch is the same all-or-nothing control the
// plug itself used to be — which is exactly the fallback path being asserted.
async function flipConnections(plug: HTMLElement) {
	await fireEvent.click(plug);
	const popover = screen.getByTestId("connections-popover");
	await fireEvent.click(within(popover).getByRole("switch"));
}

describe("MessageInput Connections toggle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		uiLanguage.set("en");
		selectedModel.set("model1");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
	});

	it("renders the toggle disabled (greyed) with a connect-in-settings tooltip when the user has no connections", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		const { getByTestId } = render(MessageInput);

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});

		const toggle = getByTestId("connections-toggle");
		// Always shown now, but disabled + pointing the user to Settings.
		expect(toggle).toBeInTheDocument();
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		expect(toggle).toHaveClass("composer-face--muted");
		expect(toggle.getAttribute("title") ?? "").toMatch(/settings/i);
	});

	it("renders the toggle defaulting on, and sends the defaultOn set in the payload", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar", "files"],
			defaultOn: ["files"],
			accounts: [],
		});
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole, getByTestId } = render(
			MessageInput,
			{ onSend: sendSpy },
		);

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const toggle = getByTestId("connections-toggle");
		expect(toggle).toHaveClass("composer-face--on");

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "What's on my calendar files today?" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: ["files"],
			}),
		);
	});

	it("turning the toggle off sends an empty capability array", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole, getByTestId } = render(
			MessageInput,
			{ onSend: sendSpy },
		);

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const toggle = getByTestId("connections-toggle");
		await flipConnections(toggle);
		expect(toggle).not.toHaveClass("composer-face--on");

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Check my schedule" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledConnectionCapabilities: [],
			}),
		);
	});

	it("defaults to on when switching to a different conversation with no remembered choice", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		const { getByTestId, rerender } = render(MessageInput, {
			conversationId: "conv-1",
		});

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const toggle = getByTestId("connections-toggle");
		await flipConnections(toggle);
		expect(toggle).not.toHaveClass("composer-face--on");

		await rerender({ conversationId: "conv-2" });

		expect(getByTestId("connections-toggle")).toHaveClass("composer-face--on");
	});

	it("localizes the toggle tooltip copy in Hungarian", async () => {
		uiLanguage.set("hu");
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		const { getByTestId } = render(MessageInput);

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const toggle = getByTestId("connections-toggle");
		// Everyday redesign: the label names the control AND its state, and
		// counts what is actually reaching this message.
		expect(toggle).toHaveAttribute(
			"aria-label",
			"Fiókok — 1 közül 1 bekapcsolva ehhez az üzenethez",
		);

		await flipConnections(toggle);
		expect(toggle).toHaveAttribute(
			"aria-label",
			"Fiókok — ehhez az üzenethez egy sincs bekapcsolva",
		);
	});

	it("remembers an off choice across the draft -> real conversation creation (no snap-back)", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		const { getByTestId, rerender } = render(MessageInput);

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const toggle = getByTestId("connections-toggle");
		await flipConnections(toggle);
		expect(toggle).not.toHaveClass("composer-face--on");

		// The draft becomes a real conversation (null -> id) — e.g. when a model
		// switch or the first send creates it. The choice must not snap back on.
		await rerender({ conversationId: "conv-created" });

		expect(getByTestId("connections-toggle")).not.toHaveClass(
			"composer-face--on",
		);
		expect(
			localStorage.getItem("alfyai:composer:connectionsDisabled:conv-created"),
		).toBe("1");
	});

	it("restores a remembered off choice on mount (survives reload / navigation)", async () => {
		localStorage.setItem(
			"alfyai:composer:connectionsDisabled:conv-remembered",
			"1",
		);
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		const sendSpy = vi.fn();
		const { getByTestId, getByPlaceholderText, getByRole } = render(
			MessageInput,
			{ conversationId: "conv-remembered", onSend: sendSpy },
		);

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		expect(getByTestId("connections-toggle")).not.toHaveClass(
			"composer-face--on",
		);

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Check my schedule" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({ enabledConnectionCapabilities: [] }),
		);
	});

	it("restores each conversation's own remembered choice when switching back", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar"],
			defaultOn: ["calendar"],
			accounts: [],
		});
		const { getByTestId, rerender } = render(MessageInput, {
			conversationId: "conv-a",
		});

		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const toggle = getByTestId("connections-toggle");
		await flipConnections(toggle);
		expect(toggle).not.toHaveClass("composer-face--on");

		// Switch to a different conversation (defaults on), then back to conv-a.
		await rerender({ conversationId: "conv-b" });
		expect(getByTestId("connections-toggle")).toHaveClass("composer-face--on");

		await rerender({ conversationId: "conv-a" });
		expect(getByTestId("connections-toggle")).not.toHaveClass(
			"composer-face--on",
		);
	});
});

// Issue 7.4 fix pass — the cloud-warning check + modal (previously local to
// this component) now live at the page level (see
// src/routes/(app)/chat/[conversationId]/+page.svelte's
// ensureCloudWarningAcked, and page-runtime.test.ts for the full
// check/modal/ack/cancel/regenerate/edit/retry scenarios). What remains
// local to MessageInput is the *contract* with its `beforeSend` prop: every
// dispatch (a fresh send AND a send queued behind an in-flight attachment
// upload) must await it before calling onSend, and must NOT clear the
// composer unless it resolves true.
describe("MessageInput send gate (beforeSend contract)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		selectedModel.set("model1");
		resetMaxFileUploadSize();
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
	});

	it("dispatches immediately when no beforeSend prop is provided (backward compatible default)", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			onSend: sendSpy,
		});

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "No gate wired up" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "No gate wired up" }),
		);
	});

	it("awaits beforeSend before dispatching, and disables Send while it is pending", async () => {
		let resolveGate: ((proceed: boolean) => void) | undefined;
		const beforeSend = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveGate = resolve;
				}),
		);
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			onSend: sendSpy,
			beforeSend,
		});

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Gate me" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(beforeSend).toHaveBeenCalledTimes(1);
		expect(sendSpy).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(
				(getByRole("button", { name: "Send message" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
		});

		resolveGate?.(true);
		await waitFor(() => {
			expect(sendSpy).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Gate me" }),
			);
		});
	});

	it("does not dispatch and preserves the composer text when beforeSend resolves false", async () => {
		const beforeSend = vi.fn().mockResolvedValue(false);
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			onSend: sendSpy,
			beforeSend,
		});

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(textarea, {
			target: { value: "Don't lose me" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		await waitFor(() => {
			expect(beforeSend).toHaveBeenCalledTimes(1);
		});
		expect(sendSpy).not.toHaveBeenCalled();
		expect(textarea.value).toBe("Don't lose me");

		// The gate is re-invoked from scratch on a fresh send — this composer
		// instance's own reentrancy guard (`sendPending`) only spans a single
		// beforeSend() call, not "forever after a cancel".
		await fireEvent.click(getByRole("button", { name: "Send message" }));
		await waitFor(() => {
			expect(beforeSend).toHaveBeenCalledTimes(2);
		});
	});

	it("does not call beforeSend a second time while the first call is still in flight (double-send race)", async () => {
		let resolveGate: ((proceed: boolean) => void) | undefined;
		const beforeSend = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveGate = resolve;
				}),
		);
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			onSend: sendSpy,
			beforeSend,
		});

		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "Race me" } });

		await fireEvent.click(getByRole("button", { name: "Send message" }));
		expect(beforeSend).toHaveBeenCalledTimes(1);

		// A second send via Ctrl+Enter (not blocked by the Send button's native
		// `disabled` the way a click would be) while the first gate call is
		// still unresolved must be a complete no-op.
		await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
		await tick();

		expect(beforeSend).toHaveBeenCalledTimes(1);
		expect(sendSpy).not.toHaveBeenCalled();

		resolveGate?.(true);
		await waitFor(() => {
			expect(sendSpy).toHaveBeenCalledTimes(1);
		});
	});

	it("routes a send queued behind an in-flight attachment upload through beforeSend instead of dispatching directly", async () => {
		const beforeSend = vi.fn().mockResolvedValue(true);
		const sendSpy = vi.fn();
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const { container, getByPlaceholderText, getByText } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onSend: sendSpy,
				onUploadFiles: uploadFilesHandler,
				beforeSend,
			},
		);

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		await fireEvent.input(textarea, {
			target: { value: "Queued while uploading" },
		});
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "notes.pdf", { type: "application/pdf" })],
			},
		});

		await waitFor(() => {
			expect(getByText("Uploading file...")).toBeDefined();
		});

		await fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

		await waitFor(() => {
			expect(
				getByText(
					"Message will send automatically when file processing finishes.",
				),
			).toBeDefined();
		});
		expect(beforeSend).not.toHaveBeenCalled();
		expect(sendSpy).not.toHaveBeenCalled();

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-queued-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "notes.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: "OCR me",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: "normalized-queued-1",
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(beforeSend).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(sendSpy).toHaveBeenCalledWith(
				expect.objectContaining({ message: "Queued while uploading" }),
			);
		});
	});
});

// "Long-document comfort" (owner-approved mockup, 2026-09-06), as reshaped by
// the chips redesign (owner-approved boards, 2026-09-15): the outline is a
// DISCLOSURE beside the attachment's chip rather than a panel stacked under
// it, and picking a section produces a QUOTE CHIP instead of pasting ~90
// characters of the document's prose into the sentence the user is writing.
// The quote is not lost — it is expanded back into the message on send.
describe("MessageInput long-document outline quoting", () => {
	it("opens the outline disclosure beside the chip and turns a section into a quote chip", async () => {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});

		const onSend = vi.fn();
		const { container, getByPlaceholderText, getByText, getByTestId } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onUploadFiles: uploadFilesHandler,
				onSend,
			},
		);

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		const file = new File(["contract text"], "contract.pdf", {
			type: "application/pdf",
		});
		await fireEvent.change(fileInput, { target: { files: [file] } });

		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-outline-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "contract.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: "Contract",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					tokenEstimate: 118_000,
					pageCount: 38,
					outline: [
						{
							level: 2,
							title: "Section 2.3 Break clause",
							offset: 0,
							preview: "Either party may terminate this agreement",
						},
					],
				},
				promptReady: true,
				promptArtifactId: "normalized-outline-1",
				readinessError: null,
			},
		});

		// The outline is closed until its disclosure is pressed — the chip row
		// stays one row high whatever is attached to it.
		await waitFor(() => {
			expect(getByTestId("attachment-outline-disclosure")).toBeDefined();
		});
		expect(container.querySelector(".attachment-outline-row")).toBeNull();

		await fireEvent.click(getByTestId("attachment-outline-disclosure"));
		await waitFor(() => {
			expect(getByText("Section 2.3 Break clause")).toBeDefined();
		});

		await fireEvent.click(getByText("Section 2.3 Break clause"));

		// A chip, not 90 characters in the textarea. The chip's label is the
		// section heading; the document's own prose stays out of the sentence.
		await waitFor(() => {
			expect(getByTestId("composer-chip-quote")).toBeDefined();
		});
		expect(textarea.value).toBe("");

		// ...and sending expands it back into the message, exactly the text
		// the old cursor-paste produced, with the typed sentence after it.
		await fireEvent.input(textarea, {
			target: { value: "Can we get out of this early?" },
		});
		await fireEvent.click(getByTestId("send-button"));

		await waitFor(() => {
			expect(onSend).toHaveBeenCalledWith(
				expect.objectContaining({
					message:
						"Section 2.3 Break clause: Either party may terminate this agreement…\n\nCan we get out of this early?",
				}),
			);
		});
	});

	it("removes a quote chip without touching the typed sentence", async () => {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});
		const {
			container,
			getByPlaceholderText,
			getByText,
			getByTestId,
			queryByTestId,
		} = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
		});

		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "Keep this text" } });

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["x"], "contract.pdf", { type: "application/pdf" })],
			},
		});
		completeUpload(doneCallback, {
			success: true,
			attachment: {
				artifact: {
					id: "artifact-outline-2",
					type: "source_document",
					retrievalClass: "durable",
					name: "contract.pdf",
					mimeType: "application/pdf",
					sizeBytes: 12,
					conversationId: "conv-1",
					summary: "Contract",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					outline: [
						{
							level: 2,
							title: "Section 2.3 Break clause",
							offset: 0,
							preview: "Either party may terminate this agreement",
						},
					],
				},
				promptReady: true,
				promptArtifactId: "normalized-outline-2",
				readinessError: null,
			},
		});

		await waitFor(() => {
			expect(getByTestId("attachment-outline-disclosure")).toBeDefined();
		});
		await fireEvent.click(getByTestId("attachment-outline-disclosure"));
		await fireEvent.click(getByText("Section 2.3 Break clause"));
		await waitFor(() => {
			expect(getByTestId("composer-chip-quote")).toBeDefined();
		});

		await fireEvent.click(
			within(
				getByTestId("composer-chip-quote").parentElement as HTMLElement,
			).getByRole("button", { name: "Remove quote Section 2.3 Break clause" }),
		);

		await waitFor(() => {
			expect(queryByTestId("composer-chip-quote")).toBeNull();
		});
		expect(textarea.value).toBe("Keep this text");
	});
});

// ── Everyday redesign: Direction B's bar and the "+" menu ────────────
//
// The bar at rest is five controls and no more: "+", attach, accounts,
// thinking, send. What the old bar had that these assert is gone: the
// incognito icon (now in the menu), the bare "0" bubble on the plug, and the
// ring that showed "0" before there was anything to measure.
describe("MessageInput composer bar (Direction B)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		uiLanguage.set("en");
		selectedModel.set("model1");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
	});

	it("rests as five controls, with incognito moved into the menu", () => {
		const { getByTestId, queryByTestId } = render(MessageInput, {
			reasoningDepth: "quick",
		});

		expect(getByTestId("composer-tools-trigger")).toBeInTheDocument();
		expect(getByTestId("attach-toggle")).toBeInTheDocument();
		expect(getByTestId("connections-toggle")).toBeInTheDocument();
		expect(getByTestId("thinking-bar-toggle")).toBeInTheDocument();
		expect(getByTestId("send-button")).toBeInTheDocument();
		expect(queryByTestId("incognito-toggle")).toBeNull();
	});

	// A hold on a bar icon is how a phone asks for the tooltip it has no
	// hover to show. It is also what every mobile browser reads as "open the
	// context menu" — Android Chrome raises one at ~500ms, right on top of
	// the label, and iOS answers with the callout and the selection
	// magnifier. Both cancel the pointer, so the gesture that asked for the
	// label is the gesture that tears it down.
	it("does not let a long press raise the browser's own context menu", () => {
		const { getByTestId } = render(MessageInput, { reasoningDepth: "quick" });

		for (const testId of [
			"attach-toggle",
			"connections-toggle",
			"thinking-bar-toggle",
		]) {
			const event = new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
			});
			getByTestId(testId).dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		}
	});

	it("leaves the composer's own text selectable — only the icons are held", () => {
		const { getByTestId } = render(MessageInput, { reasoningDepth: "quick" });
		const event = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
		});
		getByTestId("message-input").dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it("keeps the context ring away until there is context to measure", () => {
		const { container, queryByLabelText } = render(MessageInput);
		expect(queryByLabelText("No context yet")).toBeNull();
		expect(container.querySelector(".ring-root")).toBeNull();
	});

	it("shows the ring once there is context", () => {
		const { container } = render(MessageInput, {
			contextStatus: {
				conversationId: "conv-1",
				userId: "user-1",
				estimatedTokens: 4200,
				promptTokens: 4200,
				promptTokensSource: "estimated",
				maxContextTokens: 128000,
				thresholdTokens: 96000,
				targetTokens: 64000,
				compactionApplied: false,
				compactionMode: "none",
				routingStage: "deterministic",
				routingConfidence: 1,
				verificationStatus: "skipped",
				layersUsed: [],
				workingSetCount: 0,
				workingSetArtifactIds: [],
				workingSetApplied: false,
				taskStateApplied: false,
				promptArtifactCount: 0,
				recentTurnCount: 2,
				summary: null,
				updatedAt: Date.now(),
			},
		});
		expect(container.querySelector(".ring-root")).not.toBeNull();
	});

	it("shows no count bubble on the accounts icon when nothing is on", async () => {
		const { getByTestId } = render(MessageInput);
		await waitFor(() => {
			expect(fetchActiveCapabilitiesMock).toHaveBeenCalled();
		});
		const accounts = getByTestId("connections-toggle");
		expect(accounts.querySelector(".composer-connections-count")).toBeNull();
		expect(accounts).not.toHaveClass("composer-face--on");
	});

	it("shows the count, and the on-state, once accounts are on", async () => {
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: ["calendar", "files"],
			defaultOn: ["calendar", "files"],
			accounts: [],
		});
		const { getByTestId } = render(MessageInput);
		await waitFor(() => {
			expect(
				getByTestId("connections-toggle").querySelector(
					".composer-connections-count",
				)?.textContent,
			).toBe("2");
		});
		expect(getByTestId("connections-toggle")).toHaveClass("composer-face--on");
	});

	it("fills the attach icon while a file is on the message, and names it", () => {
		const { getByTestId } = render(MessageInput, {
			attachmentsEnabled: true,
			conversationId: "conv-1",
			draftVersion: 1,
			draftAttachments: [
				{
					artifact: {
						id: "artifact-bar",
						type: "source_document",
						retrievalClass: "durable",
						name: "battery-draft-b.pdf",
						mimeType: "application/pdf",
						sizeBytes: 12,
						conversationId: "conv-1",
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					promptReady: true,
					promptArtifactId: "normalized-bar",
					readinessError: null,
				},
			],
		});

		const attach = getByTestId("attach-toggle");
		expect(attach).toHaveClass("composer-face--on");
		expect(attach).toHaveAttribute("title", "Attached — 1 on this message");
	});

	// The owner's note: "the icons have a circle behind them, and I liked it
	// better when the active colour accent was more low-key." Nothing paints
	// a disc now, in any state — so the plus can take the same on-treatment
	// as the three controls beside it while its menu is open, which it could
	// not when "on" meant a filled accent circle under a white glyph.
	it("gives the plus the same on-state as the bar while its menu is open", async () => {
		const { getByTestId } = render(MessageInput);
		const plus = getByTestId("composer-tools-trigger");
		expect(plus).not.toHaveClass("composer-face--on");

		await openComposerMenu(getByTestId);
		expect(plus).toHaveClass("composer-face--on");
	});

	// The owner again, on the mark the first pass added instead of the fill:
	// a 4px dot a few pixels above the text you are typing read as a fleck of
	// dirt on the screen. The accent glyph carries "on" by itself now — so
	// the component must generate nothing under an on icon, in either the
	// desktop rule or the phone override. jsdom does not compute pseudo-
	// elements, so the rule is read from the source the way the follow-up
	// chip's is; the rendered counterpart lives in the Direction B e2e.
	it("marks an on icon with the accent glyph alone — no dot under it", () => {
		const source = readFileSync(
			`${process.cwd()}/src/lib/components/chat/MessageInput.svelte`,
			"utf-8",
		);

		expect(source).not.toContain(".composer-face--on::after");

		const onRule =
			source.match(/\n\t\.composer-face--on \{([\s\S]*?)\n\t\}/)?.[1] ?? "";
		expect(onRule).not.toBe("");
		expect(onRule).toMatch(/color:\s*var\(--accent\)/);

		const hoverRule =
			source.match(
				/\n\t\.composer-face--on:hover:not\(:disabled\) \{([\s\S]*?)\n\t\}/,
			)?.[1] ?? "";
		expect(hoverRule).toMatch(/color:\s*var\(--accent-hover\)/);
	});

	it("names the attach control and its empty state at rest", () => {
		const { getByTestId } = render(MessageInput, {
			attachmentsEnabled: true,
			conversationId: "conv-1",
		});
		expect(getByTestId("attach-toggle")).toHaveAttribute(
			"title",
			"Attach a file",
		);
	});

	it("says so plainly when uploads are unavailable", () => {
		const { getByTestId } = render(MessageInput, { attachmentsEnabled: false });
		expect(getByTestId("attach-toggle")).toHaveAttribute(
			"title",
			"File uploads are unavailable",
		);
	});
});

describe("MessageInput composer menu", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		uiLanguage.set("en");
		selectedModel.set("model1");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
		setConversationMemoryIncognitoMock.mockResolvedValue({});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
	});

	it("opens as a menu and puts focus on its first row", async () => {
		const { getByTestId } = render(MessageInput);
		const menu = await openComposerMenu(getByTestId);
		expect(menu).toHaveAttribute("role", "menu");
		await waitFor(() => {
			expect(document.activeElement).toBe(getByTestId("composer-menu-attach"));
		});
	});

	it("walks with the arrow keys and wraps at both ends", async () => {
		const { getByTestId } = render(MessageInput, { reasoningDepth: "quick" });
		const menu = await openComposerMenu(getByTestId);
		await waitFor(() => {
			expect(document.activeElement).toBe(getByTestId("composer-menu-attach"));
		});

		await fireEvent.keyDown(menu, { key: "ArrowDown" });
		await waitFor(() => {
			expect(document.activeElement).toBe(getByTestId("composer-menu-skills"));
		});

		await fireEvent.keyDown(menu, { key: "ArrowUp" });
		await waitFor(() => {
			expect(document.activeElement).toBe(getByTestId("composer-menu-attach"));
		});

		// Up from the first row lands on the last, rather than dead-ending.
		await fireEvent.keyDown(menu, { key: "End" });
		const last = document.activeElement;
		await fireEvent.keyDown(menu, { key: "Home" });
		await waitFor(() => {
			expect(document.activeElement).toBe(getByTestId("composer-menu-attach"));
		});
		expect(last).not.toBe(getByTestId("composer-menu-attach"));
	});

	// The menu is dismissed and focus goes back to the control that opened it.
	// Asserted through aria-expanded rather than the node's removal: the menu
	// plays an out transition, and jsdom never fires the animationend that
	// ends it, so the element lingers in the DOM long after the menu is
	// closed. That the transition itself collapses under reduced motion is
	// covered by reduced-motion-transitions.regression.test.ts.
	it("closes on Escape and hands focus back to the plus", async () => {
		const { getByTestId } = render(MessageInput);
		await openComposerMenu(getByTestId);
		expect(getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"true",
		);

		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await tick();

		expect(getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await waitFor(() => {
			expect(document.activeElement).toBe(
				getByTestId("composer-tools-trigger"),
			);
		});
	});

	// Was written against the Web search row, which the menu no longer has.
	// Incognito is the switch every deployment shows, so it is the one that
	// can stand for the rule.
	it("flips a switch row in place and stays open", async () => {
		const { getByTestId, queryByTestId } = render(MessageInput);
		await openComposerMenu(getByTestId);

		const incognito = getByTestId("incognito-toggle");
		expect(incognito).toHaveAttribute("aria-checked", "false");

		await fireEvent.click(incognito);

		expect(queryByTestId("composer-tools-menu")).not.toBeNull();
		await waitFor(() => {
			expect(getByTestId("incognito-toggle")).toHaveAttribute(
				"aria-checked",
				"true",
			);
		});
	});

	// The switch is gone; the capability is not — "/web selects a one-turn Web
	// search" above still passes, and the chip it raises is still how you see
	// and cancel the force.
	it("no longer offers a Web search switch", async () => {
		const { getByTestId, queryByTestId, queryByRole } = render(MessageInput);
		await openComposerMenu(getByTestId);

		expect(queryByTestId("composer-menu-web-search")).toBeNull();
		expect(queryByRole("menuitemcheckbox", { name: "Web search" })).toBeNull();
	});

	it("says how many skills are active once the menu has asked", async () => {
		discoverSkillsMock.mockResolvedValue([
			{
				id: "s1",
				ownership: "user",
				skillKind: "skill",
				displayName: "Invoice reply",
				description: "Answers an invoice question in your usual wording.",
			},
			{
				id: "s2",
				ownership: "user",
				skillKind: "skill",
				displayName: "Reply tone",
				description: "Matches the tone you use with that person.",
			},
		]);
		const { getByTestId } = render(MessageInput);
		await openComposerMenu(getByTestId);

		await waitFor(() => {
			expect(getByTestId("composer-menu-skills")).toHaveTextContent("2 active");
		});
	});

	// The plug on the bar owns the accounts: it opens the per-account
	// popover, carries the count, and holds the way through to Settings. The
	// menu behind the plus used to carry a second copy of all three, which
	// meant two places showing one state — and the copy behind the plus was
	// the one you could not read the count on.
	it("holds nothing about connections — the plug on the bar owns them", async () => {
		const { getByTestId, queryByTestId } = render(MessageInput);
		await openComposerMenu(getByTestId);

		expect(queryByTestId("composer-menu-manage-connections")).toBeNull();
		expect(queryByTestId("composer-menu-connections-master")).toBeNull();
		expect(getByTestId("connections-toggle")).toBeInTheDocument();
	});
});

// Phase 3 — the chip says what the extraction ledger says, and nothing else
// says anything. The old behaviour this replaces was a 900 ms `setTimeout`
// that flipped the label to "Extracting document text…" whether or not any
// extraction was happening.
describe("MessageInput extraction chips", () => {
	function artifact(overrides: Record<string, unknown> = {}) {
		return {
			id: "artifact-1",
			type: "source_document",
			retrievalClass: "durable",
			name: "scan.pdf",
			mimeType: "application/pdf",
			sizeBytes: 128,
			conversationId: "conv-1",
			summary: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		} as PendingAttachment["artifact"];
	}

	function extractionJob(
		overrides: Partial<DocumentExtractionJobDTO> = {},
	): DocumentExtractionJobDTO {
		return {
			id: "job-1",
			sourceArtifactId: "artifact-1",
			normalizedArtifactId: null,
			status: "queued",
			intakeRoute: "mineru",
			fileName: "scan.pdf",
			attemptCount: 0,
			maxAttempts: 3,
			retryable: false,
			cancelable: true,
			error: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			startedAt: null,
			legacy: false,
			...overrides,
		};
	}

	function renderComposer() {
		let doneCallback: ((result: UploadDoneResult) => void) | null = null;
		const uploadFilesHandler = vi.fn((payload: UploadFilesPayload) => {
			doneCallback = payload.done;
		});
		const rendered = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
		});
		return {
			...rendered,
			uploadFilesHandler,
			done: (result: UploadDoneResult) => completeUpload(doneCallback, result),
		};
	}

	async function pickFile(container: HTMLElement, name = "scan.pdf") {
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], name, { type: "application/pdf" })],
			},
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		fetchExtractionJobsMock.mockResolvedValue([]);
	});

	it("shows a chip for the file before the upload POST resolves", async () => {
		const { container, getByTestId } = renderComposer();

		await pickFile(container);

		// No artifact id exists yet: the chip is keyed on a client id and is
		// the only thing on screen that knows a file is on its way.
		await waitFor(() => {
			expect(getByTestId("composer-chip-upload")).toHaveTextContent("scan.pdf");
		});
		expect(getByTestId("composer-chip-upload")).toHaveTextContent("Uploading…");
	});

	it("swaps the optimistic chip for the real one when the upload lands", async () => {
		const { container, getByTestId, queryByTestId, done } = renderComposer();

		await pickFile(container);
		await waitFor(() =>
			expect(getByTestId("composer-chip-upload")).toBeTruthy(),
		);

		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({ status: "queued" }),
			},
		});

		await waitFor(() => {
			expect(queryByTestId("composer-chip-upload")).toBeNull();
		});
		expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
			"Waiting to be read",
		);
	});

	it("walks the real phases from the DTO the poller reports", async () => {
		const { container, getByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({ status: "queued" }),
			},
		});

		await waitFor(() => {
			expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
				"Waiting to be read",
			);
		});

		fetchExtractionJobsMock.mockResolvedValue([
			extractionJob({ status: "parsing" }),
		]);
		await waitFor(
			() => {
				expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
					"Reading…",
				);
			},
			{ timeout: 4000 },
		);

		fetchExtractionJobsMock.mockResolvedValue([
			extractionJob({ status: "indexing" }),
		]);
		await waitFor(
			() => {
				expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
					"Filing…",
				);
			},
			{ timeout: 4000 },
		);

		fetchExtractionJobsMock.mockResolvedValue([
			extractionJob({
				status: "succeeded",
				cancelable: false,
				normalizedArtifactId: "normalized-1",
			}),
		]);
		await waitFor(
			() => {
				expect(getByTestId("composer-chip-attachment")).not.toHaveTextContent(
					"Filing…",
				);
			},
			{ timeout: 4000 },
		);
	});

	it("never changes the label on a timer when no job is active", async () => {
		vi.useFakeTimers();
		try {
			const { container, getByTestId, done } = renderComposer();

			await pickFile(container);
			done({
				success: true,
				attachment: {
					artifact: artifact(),
					// An older server that says nothing about extraction. The chip
					// must look exactly as it did before the ledger existed, and no
					// amount of elapsed time may change that.
					promptReady: true,
					promptArtifactId: "normalized-1",
					readinessError: null,
				},
			});
			await tick();

			const before = getByTestId("composer-chip-attachment").textContent;
			await vi.advanceTimersByTimeAsync(30_000);

			expect(getByTestId("composer-chip-attachment").textContent).toBe(before);
			// It asks once — it cannot know there is no job without asking — and
			// then stops for good, because the answer was "nothing here".
			expect(fetchExtractionJobsMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers Cancel while the job is running and calls the endpoint", async () => {
		cancelExtractionMock.mockResolvedValue(
			extractionJob({ status: "canceled", cancelable: false }),
		);
		const { container, getByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({ status: "parsing" }),
			},
		});

		const cancel = await waitFor(() =>
			getByTestId("composer-chip-extraction-cancel"),
		);
		expect(cancel).toHaveAttribute("aria-label", "Stop reading scan.pdf");

		await fireEvent.click(cancel);
		expect(cancelExtractionMock).toHaveBeenCalledWith("artifact-1");

		await waitFor(() => {
			expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
				"Stopped",
			);
		});
	});

	it("offers Retry on a retryable failure and adopts the requeued job", async () => {
		retryExtractionMock.mockResolvedValue(
			extractionJob({ status: "queued", retryable: false }),
		);
		const { container, getByTestId, queryByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({
					status: "failed",
					retryable: true,
					cancelable: false,
					error: { code: "max_attempts", message: "gave up" },
				}),
			},
		});

		await waitFor(() => {
			expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
				"Could not be read — retry",
			);
		});
		expect(queryByTestId("composer-chip-extraction-cancel")).toBeNull();

		await fireEvent.click(getByTestId("composer-chip-extraction-retry"));
		expect(retryExtractionMock).toHaveBeenCalledWith("artifact-1");

		await waitFor(() => {
			expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
				"Waiting to be read",
			);
		});
	});

	// F21. Retry requeues the job, so the button that was just pressed
	// unmounts and a keyboard user was left on `<body>`, at the top of the
	// page, with no idea where they had been.
	it("fires Retry once per click and moves focus to the chip when it unmounts", async () => {
		let releaseRetry: (job: DocumentExtractionJobDTO) => void = () => {};
		retryExtractionMock.mockImplementation(
			() =>
				new Promise<DocumentExtractionJobDTO>((resolve) => {
					releaseRetry = resolve;
				}),
		);
		const { container, getByTestId, queryByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({
					status: "failed",
					retryable: true,
					cancelable: false,
					error: { code: "max_attempts", message: "gave up" },
				}),
			},
		});

		const retry = await waitFor(() =>
			getByTestId("composer-chip-extraction-retry"),
		);
		retry.focus();
		await fireEvent.click(retry);
		await waitFor(() => {
			expect(getByTestId("composer-chip-extraction-retry")).toHaveAttribute(
				"aria-busy",
				"true",
			);
		});

		// A second click while the first is still in flight must not fire a
		// second request — each one burns another attempt on the same document.
		await fireEvent.click(getByTestId("composer-chip-extraction-retry"));
		expect(retryExtractionMock).toHaveBeenCalledTimes(1);

		releaseRetry(extractionJob({ status: "queued", retryable: false }));

		await waitFor(() => {
			expect(queryByTestId("composer-chip-extraction-retry")).toBeNull();
		});
		await waitFor(() => {
			expect(document.activeElement).toBe(
				container.querySelector(".composer-chip__remove"),
			);
		});
	});

	it("announces a real state change once, not once per poll", async () => {
		const { container, getByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({ status: "parsing" }),
			},
		});

		const announcer = await waitFor(() =>
			getByTestId("composer-extraction-announcer"),
		);
		// The state it was drawn in is not a change: the user can see the chip.
		expect(announcer).toHaveTextContent("");

		fetchExtractionJobsMock.mockResolvedValue([
			extractionJob({ status: "succeeded", cancelable: false }),
		]);
		await waitFor(
			() => {
				expect(announcer).toHaveTextContent("scan.pdf:");
			},
			{ timeout: 3000 },
		);
	});

	it("names the cause, and offers no Retry, when a retry cannot help", async () => {
		const { container, getByTestId, queryByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({
					status: "failed",
					retryable: false,
					cancelable: false,
					error: { code: "too_large", message: "over the cap" },
				}),
			},
		});

		await waitFor(() => {
			expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
				"Too large to read",
			);
		});
		expect(queryByTestId("composer-chip-extraction-retry")).toBeNull();
	});

	it("says a failed retry failed without rewriting the chip", async () => {
		retryExtractionMock.mockRejectedValue(new Error("offline"));
		const { container, getByTestId, done } = renderComposer();

		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({
					status: "failed",
					retryable: true,
					cancelable: false,
					error: { code: "max_attempts", message: "gave up" },
				}),
			},
		});

		await fireEvent.click(
			await waitFor(() => getByTestId("composer-chip-extraction-retry")),
		);

		await waitFor(() => {
			expect(getByTestId("extraction-action-error")).toHaveTextContent(
				"scan.pdf could not be sent for reading again.",
			);
		});
		// The chip still reflects the last state the SERVER reported.
		expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
			"Could not be read — retry",
		);
	});

	it("treats a pending extraction as 'not yet', not as a failure", async () => {
		const { container, getByPlaceholderText, getByTestId, queryByText, done } =
			renderComposer();

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Summarise this" },
		});
		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				// The upload route's own readiness verdict, which for a document
				// that is still being read is "no" — and used to be shown in red
				// under the composer as a permanent failure.
				promptReady: false,
				promptArtifactId: null,
				readinessError: "This file could not be prepared for chat.",
				extraction: extractionJob({ status: "parsing" }),
			},
		});

		await waitFor(() => {
			expect(getByTestId("send-disabled-hint")).toHaveTextContent(
				"Extracting document text…",
			);
		});
		expect(
			queryByText("scan.pdf: This file could not be prepared for chat."),
		).toBeNull();
	});

	it("stops holding Send once the job reaches a terminal status", async () => {
		const { container, getByPlaceholderText, getByLabelText, done } =
			renderComposer();

		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Summarise this" },
		});
		await pickFile(container);
		done({
			success: true,
			attachment: {
				artifact: artifact(),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({ status: "parsing" }),
			},
		});

		const sendButton = getByLabelText("Send message") as HTMLButtonElement;
		await waitFor(() => expect(sendButton.disabled).toBe(true));

		fetchExtractionJobsMock.mockResolvedValue([
			extractionJob({
				status: "succeeded",
				cancelable: false,
				normalizedArtifactId: "normalized-1",
			}),
		]);

		await waitFor(() => expect(sendButton.disabled).toBe(false), {
			timeout: 4000,
		});
	});

	it("re-hydrates the chip from a draft restored mid-extraction", async () => {
		// Reload the page while a PDF is being read. Before this the restored
		// chip came back solid and ordinary — no "Reading…", no dashed edge, no
		// Stop — with the server's English readiness sentence in red beneath it,
		// until the first poll landed a second later.
		const { getByTestId, queryByText } = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: vi.fn(),
			draftVersion: 1,
			draftText: "Summarise this",
			draftAttachments: [
				{
					artifact: artifact(),
					promptReady: false,
					promptArtifactId: null,
					readinessError:
						"This file is still being prepared for chat. Wait a moment and send it again.",
					extraction: extractionJob({ status: "parsing" }),
				},
			],
		});

		await waitFor(() => {
			expect(getByTestId("composer-chip-attachment")).toHaveTextContent(
				"Reading…",
			);
		});
		expect(queryByText(/still being prepared for chat/i)).toBeNull();
	});

	it("keeps the upload state while a dropped second batch is in flight", async () => {
		// The file picker is closed while an upload runs (`canAttach` goes
		// false); the page's DROP handler is not — it checks read-only and
		// sending only, and calls the composer's registered upload function
		// directly. A second batch used to ASSIGN the pending counter rather than
		// add to it, so the first batch's callbacks drove it to zero, cleared
		// "Uploading…" and opened the send gate while the second batch was still
		// uploading.
		let uploadFn: ((files: FileList | null) => Promise<void>) | null = null;
		const dones: Array<(result: UploadDoneResult) => void> = [];
		const { getByTestId, queryByTestId, getByPlaceholderText } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onUploadReady: (fn: (files: FileList | null) => Promise<void>) => {
					uploadFn = fn;
				},
				onUploadFiles: (payload: UploadFilesPayload) => {
					dones.push(payload.done);
				},
			},
		);

		// The hint only renders once there is a message to send.
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Summarise these" },
		});

		const drop = (name: string) =>
			(uploadFn as unknown as (files: FileList) => Promise<void>)([
				new File(["x"], name, { type: "application/pdf" }),
			] as unknown as FileList);

		await drop("first.pdf");
		await drop("second.pdf");
		await waitFor(() => expect(dones).toHaveLength(2));

		// The first upload lands; the second has not.
		dones[0]?.({
			success: true,
			attachment: {
				artifact: artifact({ id: "artifact-1", name: "first.pdf" }),
				promptReady: false,
				promptArtifactId: null,
				readinessError: null,
				extraction: extractionJob({ status: "queued" }),
			},
		});

		await waitFor(() =>
			expect(getByTestId("composer-chip-attachment")).toBeTruthy(),
		);
		// The second file’s optimistic chip is still up...
		expect(queryByTestId("composer-chip-upload")).toBeTruthy();
		// ...and the composer still knows it is uploading, which is what the
		// counter is for. With the assignment bug the counter reached zero here
		// and the hint switched to "preparing" — the wording for a file that has
		// finished uploading — while the second file was still on the wire.
		expect(getByTestId("send-disabled-hint")).toHaveTextContent(
			"Uploading file...",
		);
	});

	it("drops the optimistic chip when the upload fails", async () => {
		const { container, queryByTestId, done } = renderComposer();

		await pickFile(container);
		done({ success: false, fileName: "scan.pdf", error: "Upload failed" });

		await waitFor(() => {
			expect(queryByTestId("composer-chip-upload")).toBeNull();
		});
	});
});

// Paste-to-attach (phase5-6 spec §3.6). The composer's first paste handler,
// so most of what this block asserts is what it does NOT do: every text paste
// in the product now passes through here, and one that is not an attachment
// must reach the browser untouched.
describe("MessageInput paste-to-attach", () => {
	/**
	 * A real event rather than `fireEvent.paste`'s synthetic one, so
	 * `defaultPrevented` can be read back — "did this swallow the paste?" is
	 * the most important assertion in this block and it is invisible from the
	 * component's props.
	 */
	function paste(
		target: HTMLElement,
		clipboard: { types: string[]; files?: File[] },
	): Event {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: { types: clipboard.types, files: clipboard.files ?? [] },
		});
		target.dispatchEvent(event);
		return event;
	}

	function screenshot(name = "image.png"): File {
		return new File(["png bytes"], name, { type: "image/png" });
	}

	function renderComposer(props: Record<string, unknown> = {}) {
		const uploadFilesHandler = vi.fn((_payload: UploadFilesPayload) => {});
		const rendered = render(MessageInput, {
			conversationId: "conv-1",
			attachmentsEnabled: true,
			onUploadFiles: uploadFilesHandler,
			...props,
		});
		return {
			...rendered,
			uploadFilesHandler,
			textarea: rendered.container.querySelector(
				"textarea",
			) as HTMLTextAreaElement,
		};
	}

	function pastedFiles(handler: ReturnType<typeof vi.fn>): File[] {
		const payload = handler.mock.calls[0]?.[0] as UploadFilesPayload;
		return payload.files;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		resetMaxFileUploadSize();
		resetDisabledFileTypeIds();
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		fetchActiveCapabilitiesMock.mockResolvedValue({
			served: [],
			defaultOn: [],
			accounts: [],
		});
		fetchExtractionJobsMock.mockResolvedValue([]);
	});

	afterEach(() => {
		resetDisabledFileTypeIds();
	});

	it("attaches a screenshot, which carries files and no text", async () => {
		const { textarea, uploadFilesHandler } = renderComposer();

		const event = paste(textarea, {
			types: ["Files", "image/png"],
			files: [screenshot()],
		});

		await waitFor(() => expect(uploadFilesHandler).toHaveBeenCalledTimes(1));
		expect(event.defaultPrevented).toBe(true);
		const files = pastedFiles(uploadFilesHandler);
		expect(files).toHaveLength(1);
		// The browser's placeholder name is replaced with a generated one
		// carrying the registry's canonical extension for the MIME.
		expect(files[0].name).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
	});

	it("leaves a plain text paste to the browser", async () => {
		const { textarea, uploadFilesHandler } = renderComposer();

		const event = paste(textarea, { types: ["text/plain"] });

		await tick();
		expect(uploadFilesHandler).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	// The case the conservative rule exists for. Copying a range from Excel, a
	// paragraph from Word or a figure from a web page puts an image on the
	// clipboard BESIDE the text; attaching those would make the composer
	// unusable for the everyday paste.
	it("leaves a Word/Excel paste alone although it carries an image", async () => {
		const { textarea, uploadFilesHandler } = renderComposer();

		const event = paste(textarea, {
			types: ["text/plain", "text/html", "Files"],
			files: [screenshot()],
		});

		await tick();
		expect(uploadFilesHandler).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("attaches every file of a multi-file paste, in order", async () => {
		const { textarea, uploadFilesHandler } = renderComposer();

		paste(textarea, {
			types: ["Files"],
			files: [
				new File(["a"], "notes.md", { type: "text/markdown" }),
				new File(["b"], "budget.xlsx", { type: "application/vnd.ms-excel" }),
			],
		});

		await waitFor(() => expect(uploadFilesHandler).toHaveBeenCalledTimes(1));
		expect(pastedFiles(uploadFilesHandler).map((file) => file.name)).toEqual([
			"notes.md",
			"budget.xlsx",
		]);
	});

	it("speaks the attach in the live region", async () => {
		const { textarea, getByTestId } = renderComposer();

		paste(textarea, { types: ["Files"], files: [screenshot("chart.png")] });

		await waitFor(() =>
			expect(getByTestId("composer-attachment-announcer")).toHaveTextContent(
				"chart.png attached from the clipboard.",
			),
		);
	});

	it("counts a multi-file paste as one announcement", async () => {
		const { textarea, getByTestId } = renderComposer();

		paste(textarea, {
			types: ["Files"],
			files: [screenshot("a.png"), screenshot("b.png")],
		});

		await waitFor(() =>
			expect(getByTestId("composer-attachment-announcer")).toHaveTextContent(
				"2 files attached from the clipboard.",
			),
		);
	});

	it("shows the refusal for a file the server would refuse", async () => {
		const { textarea, uploadFilesHandler, findByText } = renderComposer();

		const event = paste(textarea, {
			types: ["Files"],
			files: [new File(["mp4"], "clip.mp4", { type: "video/mp4" })],
		});

		expect(
			await findByText(/Audio and video files can't be read yet/i),
		).toBeDefined();
		expect(uploadFilesHandler).not.toHaveBeenCalled();
		// Nothing was attached, so nothing was swallowed either.
		expect(event.defaultPrevented).toBe(false);
	});

	it("attaches the good files of a mixed paste and names the refusal", async () => {
		const { textarea, uploadFilesHandler, findByText } = renderComposer();

		paste(textarea, {
			types: ["Files"],
			files: [
				new File(["pdf"], "report.pdf", { type: "application/pdf" }),
				new File(["zip"], "archive.zip", { type: "application/zip" }),
			],
		});

		await waitFor(() => expect(uploadFilesHandler).toHaveBeenCalledTimes(1));
		expect(pastedFiles(uploadFilesHandler).map((file) => file.name)).toEqual([
			"report.pdf",
		]);
		expect(
			await findByText(/Unpack it and upload the files inside/i),
		).toBeDefined();
	});

	// The MinerU-4 gate (spec D6) reaches a paste through the same store both
	// accept strings read.
	it("refuses a gated format once the gate closes", async () => {
		const { textarea, uploadFilesHandler, container } = renderComposer();
		const epub = () =>
			new File(["epub"], "novel.epub", { type: "application/epub+zip" });

		paste(textarea, { types: ["Files"], files: [epub()] });
		await waitFor(() => expect(uploadFilesHandler).toHaveBeenCalledTimes(1));

		setDisabledFileTypeIds(["epub"]);
		await tick();

		paste(textarea, { types: ["Files"], files: [epub()] });
		await tick();
		// Still one call: the second paste was refused, not attached.
		expect(uploadFilesHandler).toHaveBeenCalledTimes(1);

		// ...and the picker stopped offering it at the same moment.
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		expect(fileInput.getAttribute("accept")?.split(",")).not.toContain(".epub");
	});

	it("publishes the gated accept string on the file input", async () => {
		const { container } = renderComposer();
		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;

		// Open gate: byte-identical to the ungated string, so no surface moved.
		expect(fileInput.getAttribute("accept")).toBe(getAcceptAttribute("chat"));

		setDisabledFileTypeIds(["rtf", "odt", "ods", "odp", "epub"]);
		await tick();

		const offered = fileInput.getAttribute("accept")?.split(",") ?? [];
		expect(offered).not.toContain(".rtf");
		expect(offered).not.toContain(".epub");
		// HTML is gated too but declares a fallback route, so it never leaves.
		expect(offered).toContain(".html");
		expect(offered).toContain(".pdf");
	});

	it("does nothing when the composer is disabled", async () => {
		const { textarea, uploadFilesHandler } = renderComposer({ disabled: true });

		const event = paste(textarea, { types: ["Files"], files: [screenshot()] });

		await tick();
		expect(uploadFilesHandler).not.toHaveBeenCalled();
		// A disabled composer still must not swallow the event.
		expect(event.defaultPrevented).toBe(false);
	});

	it("does nothing when attachments are switched off", async () => {
		const { textarea, uploadFilesHandler } = renderComposer({
			attachmentsEnabled: false,
		});

		const event = paste(textarea, { types: ["Files"], files: [screenshot()] });

		await tick();
		expect(uploadFilesHandler).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	// The batch counter Phase 3 fixed: the file picker closes while an upload
	// is in flight, but a paste does not, so the second batch must ADD to the
	// count rather than replace it.
	it("counts a paste made while an upload is already in flight", async () => {
		const dones: ((result: UploadDoneResult) => void)[] = [];
		const { container, getByPlaceholderText, getByTestId } = render(
			MessageInput,
			{
				conversationId: "conv-1",
				attachmentsEnabled: true,
				onUploadFiles: (payload: UploadFilesPayload) => {
					dones.push(payload.done);
				},
			},
		);
		const textarea = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "Summarise these" } });

		const fileInput = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		await fireEvent.change(fileInput, {
			target: {
				files: [new File(["scan"], "scan.pdf", { type: "application/pdf" })],
			},
		});
		await waitFor(() => expect(dones).toHaveLength(1));

		paste(textarea, { types: ["Files"], files: [screenshot("shot.png")] });
		await waitFor(() => expect(dones).toHaveLength(2));

		// The picked file lands; the pasted one has not.
		dones[0]?.({
			success: false,
			fileName: "scan.pdf",
			error: "Upload failed",
		});
		await tick();

		// The composer still knows it is uploading. With an assignment rather
		// than an increment the counter would have hit zero here and opened the
		// send gate while the pasted screenshot was still on the wire.
		expect(getByTestId("send-disabled-hint")).toHaveTextContent(
			"Uploading file...",
		);
	});

	it("attaches a paste on a phone viewport too", async () => {
		const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 390,
		});
		try {
			const { textarea, uploadFilesHandler } = renderComposer();
			paste(textarea, { types: ["Files"], files: [screenshot()] });
			await waitFor(() => expect(uploadFilesHandler).toHaveBeenCalledTimes(1));
		} finally {
			if (original) Object.defineProperty(window, "innerWidth", original);
		}
	});

	it("leaves the quote chips alone", async () => {
		const { textarea, getByTestId, queryByTestId } = renderComposer();

		requestComposerQuote("A quoted section of the document.");
		await waitFor(() =>
			expect(getByTestId("composer-chip-quote")).toBeDefined(),
		);

		paste(textarea, { types: ["Files"], files: [screenshot()] });
		await tick();

		// A paste attaches files; it neither adds nor removes a quote, and the
		// words in the textarea stay the user's own.
		expect(queryByTestId("composer-chip-quote")).toBeTruthy();
		expect(textarea.value).toBe("");
	});
});
