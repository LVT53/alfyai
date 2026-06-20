import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { PendingAttachment } from "$lib/types";
import MessageInput from "./MessageInput.svelte";
import MessageInputWrapper from "./MessageInputWrapper.test.svelte";

type UploadDoneResult =
	| { success: true; attachment: PendingAttachment }
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

vi.mock("$lib/client/api/knowledge", () => ({
	fetchKnowledgeLibrary: fetchKnowledgeLibraryMock,
}));

vi.mock("$lib/client/api/skills", () => ({
	discoverSkills: discoverSkillsMock,
}));

describe("MessageInput", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		fetchKnowledgeLibraryMock.mockResolvedValue({
			documents: [],
			results: [],
			workflows: [],
		});
		discoverSkillsMock.mockResolvedValue([]);
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

	it("sends one-turn Web search from the composer tools toggle", async () => {
		const sendSpy = vi.fn();
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			onSend: sendSpy,
		});

		await fireEvent.click(getByRole("button", { name: "Open composer tools" }));
		await fireEvent.click(
			getByRole("menuitemcheckbox", { name: "Web search" }),
		);
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
		await fireEvent.click(getByRole("menuitem", { name: "Atlas" }));
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

		expect(
			getByRole("list", { name: "Active composer controls" }),
		).toHaveTextContent("Atlas: In-Depth");

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
		await fireEvent.click(getByRole("menuitem", { name: "Atlas" }));

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
		await fireEvent.click(getByRole("menuitem", { name: "Atlas" }));
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

		expect(queryByText("Atlas: Overview")).toBeNull();
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

	it("opens /depth and sends the selected Reasoning depth", async () => {
		const sendSpy = vi.fn();
		const reasoningDepthChangeSpy = vi.fn();
		const { getByPlaceholderText, getByRole, queryByRole, rerender } = render(
			MessageInput,
			{
				composerCommandRegistryEnabled: true,
				onSend: sendSpy,
				reasoningDepth: "auto",
				onReasoningDepthChange: reasoningDepthChangeSpy,
			},
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/depth" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		const depthPicker = getByRole("listbox", { name: "Reasoning depth" });
		expect(
			within(depthPicker).getByRole("option", { name: "Off" }),
		).toBeInTheDocument();
		expect(
			within(depthPicker).getByRole("option", { name: "Auto" }),
		).toBeInTheDocument();
		expect(
			within(depthPicker).getByRole("option", { name: "Max" }),
		).toBeInTheDocument();
		expect(
			within(depthPicker).queryByRole("option", { name: "On" }),
		).toBeNull();

		await fireEvent.click(
			within(depthPicker).getByRole("option", { name: "Max" }),
		);
		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("max");
		expect(queryByRole("listbox", { name: "Reasoning depth" })).toBeNull();
		await rerender({
			composerCommandRegistryEnabled: true,
			onSend: sendSpy,
			reasoningDepth: "max",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		await fireEvent.input(input, {
			target: { value: "Use maximum reasoning" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Use maximum reasoning",
				reasoningDepth: "max",
			}),
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
			onSend: sendSpy,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.click(getByRole("button", { name: "Open composer tools" }));
		await fireEvent.click(
			getByRole("menuitemcheckbox", { name: "Web search" }),
		);
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
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/" } });

		expect(getByRole("status")).toHaveTextContent(
			"Active command: /model Model",
		);
		await fireEvent.keyDown(input, { key: "ArrowDown" });

		expect(getByRole("status")).toHaveTextContent(
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
			target: { value: "Please /web now" },
		});
		input.setSelectionRange(11, 11);
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(input.value).toBe("Please  now");
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
		const pendingSkillList = getByRole("list", { name: "Pending skill" });
		expect(
			within(pendingSkillList).getByText("User Skill"),
		).toBeInTheDocument();
		expect(
			pendingSkillList.querySelector(".pending-skill-chip"),
		).not.toBeNull();
		expect(pendingSkillList.querySelector(".linked-source-chip")).toBeNull();
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

		const pendingSkillList = getByRole("list", { name: "Pending skill" });
		expect(
			within(pendingSkillList).getByText("Skill Variant"),
		).toBeInTheDocument();
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
		const pendingSkillList = getByRole("list", { name: "Pending skill" });
		expect(
			within(pendingSkillList).getByText("Skill Variant"),
		).toBeInTheDocument();
		expect(
			pendingSkillList.querySelector(".pending-skill-chip"),
		).not.toBeNull();
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
			target: { value: "Keep this draft /clear" },
		});
		input.setSelectionRange(input.value.length, input.value.length);
		await fireEvent.click(getByRole("option", { name: /\/clear/i }));

		expect(confirmSpy).toHaveBeenCalledWith(
			"Clear the current draft and pending composer selections?",
		);
		expect(input.value).toBe("Keep this draft /clear");
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
			target: { value: "Remove this draft /clear" },
		});
		input.setSelectionRange(input.value.length, input.value.length);
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

	it("opens Reasoning depth controls from the slash command", async () => {
		const { getByPlaceholderText, getByRole } = render(MessageInput, {
			composerCommandRegistryEnabled: true,
		});
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		await fireEvent.input(input, { target: { value: "/depth" } });
		await fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

		expect(input.value).toBe("");
		expect(
			getByRole("listbox", { name: "Reasoning depth" }),
		).toBeInTheDocument();
		expect(getByRole("option", { name: "Off" })).toBeInTheDocument();
	});

	it("sends the selected Reasoning depth with the next message", async () => {
		const sendSpy = vi.fn();
		const reasoningDepthChangeSpy = vi.fn();
		const { getByPlaceholderText, getByRole, rerender } = render(MessageInput, {
			onSend: sendSpy,
			reasoningDepth: "auto",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});

		await fireEvent.click(getByRole("button", { name: "Open composer tools" }));
		await fireEvent.click(getByRole("button", { name: "Auto" }));
		await fireEvent.click(getByRole("option", { name: "Off" }));

		expect(reasoningDepthChangeSpy).toHaveBeenCalledWith("off");

		await rerender({
			onSend: sendSpy,
			reasoningDepth: "off",
			onReasoningDepthChange: reasoningDepthChangeSpy,
		});
		await fireEvent.input(getByPlaceholderText("Type a message..."), {
			target: { value: "Answer directly" },
		});
		await fireEvent.click(getByRole("button", { name: "Send message" }));

		expect(sendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Answer directly",
				reasoningDepth: "off",
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

	it("shows character count and blocks send when over limit", async () => {
		const maxLength = 10;
		const mockSend = vi.fn();
		const { getByPlaceholderText, getByLabelText, getByText } = render(
			MessageInputWrapper,
			{ maxLength, onSend: mockSend },
		);
		const input = getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const button = getByLabelText("Send message") as HTMLButtonElement;

		await fireEvent.input(input, { target: { value: "123456789" } });
		expect(getByText("9/10")).toBeDefined();
		expect(button.disabled).toBe(false);

		await fireEvent.input(input, { target: { value: "12345678901" } });
		expect(getByText("11/10")).toBeDefined();
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

		await fireEvent.click(getByLabelText(/prompt budget usage/i));

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

		await fireEvent.click(getByLabelText(/prompt budget usage/i));
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
			onUploadReady: (uploadFn) => {
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
});
