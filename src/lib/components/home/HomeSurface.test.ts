import { render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import {
	consumeHomeComposerSeed,
	setLandingDraftConversationId,
	storeHomeComposerSeed,
} from "$lib/client/conversation-session";
import Header from "$lib/components/layout/Header.svelte";
import { t } from "$lib/i18n";
import type { ConversationDraft } from "$lib/server/services/conversations";
import { uiLanguage } from "$lib/stores/settings";
import { requestSpotlight, spotlightRequest } from "$lib/stores/spotlight";
import { clearToasts, toasts } from "$lib/stores/toast";
import {
	landingIncognitoArmed,
	landingIncognitoArmVisible,
} from "$lib/stores/ui";
import HomeSurface from "./HomeSurface.svelte";

/**
 * The extraction's own guard rail (Workspaces Slice D, Task D2).
 *
 * `HomeSurface` renders in two modes and the mode table in
 * `docs/plans/claude-at-home-1/slice-D.md` is short and exact: on the landing
 * page the greeting is the greeting pool, the composer's placeholder is the
 * ordinary one, and there is nothing under the composer. The project page —
 * where the greeting is the project's name, the placeholder names the project
 * and a quiet instructions line sits under the composer — is Task D3.
 *
 * This file asserts the negative half: in `home` mode none of the project
 * markers may appear. The markers are the test ids the project branch uses
 * (`project-greeting`, `project-quiet-line`, `project-instructions-button`),
 * so if the branch ever reaches the landing page — a mode comparison that
 * matches too much, a marker hoisted out of the project-only block — these
 * fail rather than shipping a landing page wearing a project's name.
 *
 * The API modules are mocked the way MessageInput.test.ts mocks them: this
 * surface mounts the real composer, which fetches on mount.
 */

const gotoMock = vi.hoisted(() => vi.fn());
const fetchAvailableModelsMock = vi.hoisted(() =>
	vi.fn(async () => ({ providers: [], modelAliases: {} })),
);
const fetchKnowledgeLibraryMock = vi.hoisted(() =>
	vi.fn(async () => ({ documents: [], results: [], workflows: [] })),
);
const fetchExtractionJobsMock = vi.hoisted(() => vi.fn(async () => []));
const fetchExtractionStatusMock = vi.hoisted(() =>
	vi.fn(async () => ({ jobs: [], readiness: [] })),
);
const discoverSkillsMock = vi.hoisted(() => vi.fn(async () => []));
const fetchActiveCapabilitiesMock = vi.hoisted(() =>
	vi.fn(async () => ({ served: [], defaultOn: [], accounts: [] })),
);
const fetchPublicPersonalityProfilesMock = vi.hoisted(() =>
	vi.fn(async () => []),
);
const fetchSystemCapabilitiesMock = vi.hoisted(() =>
	vi.fn(async () => ({ capabilities: [], degraded: [] })),
);
// What the server answers when Home opens and reads back the landing page's
// saved draft. Only the tests that save one answer it.
const fetchConversationDetailMock = vi.hoisted(() => vi.fn());

vi.mock("$app/navigation", () => ({ goto: gotoMock }));
vi.mock("$lib/client/api/conversations", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/conversations")>()),
	fetchConversationDetail: fetchConversationDetailMock,
}));
vi.mock("$lib/client/api/models", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/models")>()),
	fetchAvailableModels: fetchAvailableModelsMock,
}));
vi.mock("$lib/client/api/knowledge", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/knowledge")>()),
	fetchKnowledgeLibrary: fetchKnowledgeLibraryMock,
	fetchExtractionJobs: fetchExtractionJobsMock,
	fetchExtractionStatus: fetchExtractionStatusMock,
}));
vi.mock("$lib/client/api/skills", () => ({
	discoverSkills: discoverSkillsMock,
}));
vi.mock("$lib/client/api/connections", () => ({
	fetchActiveCapabilities: fetchActiveCapabilitiesMock,
}));
vi.mock("$lib/client/api/admin", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/admin")>()),
	fetchPublicPersonalityProfiles: fetchPublicPersonalityProfilesMock,
}));
vi.mock("$lib/client/api/system", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/system")>()),
	fetchSystemCapabilities: fetchSystemCapabilitiesMock,
}));
vi.mock("$lib/client/api/home", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/client/api/home")>()),
	dismissMemoryReviewNotice: vi.fn(async () => undefined),
}));

function renderHome() {
	return render(HomeSurface, { mode: { kind: "home" }, recent: [] });
}

describe("HomeSurface in home mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		gotoMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("composes into the ordinary chat placeholder, never a project one", () => {
		renderHome();

		const textarea = screen.getByPlaceholderText(
			get(t)("chat.messagePlaceholder"),
		);
		expect(textarea).toBeInTheDocument();
		// Exactly the landing placeholder: a project page's "Start a chat in
		// {name}…" would fail this rather than merely look different.
		expect(textarea).toHaveAttribute(
			"placeholder",
			get(t)("chat.messagePlaceholder"),
		);
	});

	it("greets with the landing heading, not a project name", () => {
		renderHome();

		expect(screen.getByTestId("home-greeting")).toBeInTheDocument();
		expect(screen.queryByTestId("project-greeting")).toBeNull();
	});

	it("renders no instructions line under the composer", () => {
		renderHome();

		// The quiet line is the project page's only affordance under the
		// composer; on the landing page there is nothing there.
		expect(screen.queryByTestId("project-quiet-line")).toBeNull();
		expect(screen.queryByTestId("project-instructions-button")).toBeNull();
	});

	it("keeps the landing greeting band's own weekly record", () => {
		// The project page replaces the weekly bars with a stats line. The
		// landing page keeps them: same component, different mode.
		const { container } = renderHome();

		expect(screen.getByTestId("home-greeting")).toBeInTheDocument();
		expect(container.querySelector("[data-testid='project-stats']")).toBeNull();
	});
});

// The files half of the project page's quiet line counts the project's bundle:
// its files and what its chats made. Once anything in it was made by a chat the
// word is "items" — "3 files" would be a claim about three uploads — and a
// bundle of only files keeps the word it always had.
describe("HomeSurface in project mode: the files half of the quiet line", () => {
	function renderProject(options: {
		fileCount?: number;
		hasMadeItems?: boolean;
	}) {
		return render(HomeSurface, {
			mode: {
				kind: "project",
				project: { id: "project-1", name: "Vienna trip" },
				chatCount: 1,
				lastActivityAt: null,
				...options,
			},
			recent: [],
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		gotoMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		uiLanguage.set("en");
	});

	it("counts files while the bundle holds only files", () => {
		renderProject({ fileCount: 3, hasMadeItems: false });
		expect(screen.getByTestId("project-files-button")).toHaveTextContent(
			"3 files",
		);
	});

	it("counts items once a chat made something in it", () => {
		renderProject({ fileCount: 3, hasMadeItems: true });
		expect(screen.getByTestId("project-files-button")).toHaveTextContent(
			"3 items",
		);
	});

	it("says a single made item in the singular", () => {
		renderProject({ fileCount: 1, hasMadeItems: true });
		expect(screen.getByTestId("project-files-button")).toHaveTextContent(
			"1 item",
		);
	});

	it("says it in Hungarian too", () => {
		uiLanguage.set("hu");
		renderProject({ fileCount: 4, hasMadeItems: true });
		expect(screen.getByTestId("project-files-button")).toHaveTextContent(
			"4 elem",
		);
	});

	it("offers to add files while the bundle is empty", () => {
		renderProject({ fileCount: 0 });
		expect(screen.getByTestId("project-files-button")).toHaveTextContent(
			get(t)("projects.addFiles"),
		);
	});
});

// The Feature Guide's "Try it" stores an example (`storeHomeComposerSeed`) and
// opens Home. The example goes into the box, unsent, and never over the person's
// words: a saved draft with words is kept (a toast says the example was left
// out), one with no words but something else (files, linked sources, Atlas mode)
// takes the example as its words and keeps the rest, and with no draft the
// example is the draft. That draft is the landing page's saved one, which Home
// reads back from the server as it opens, so the tests that save one answer that
// read.
describe("HomeSurface and an example Try it left for Home", () => {
	const example =
		"How do I get from Keleti station to the airport by public transport?";
	const requests: Array<{ url: string; method: string }> = [];

	function landingBox(): HTMLTextAreaElement {
		return screen.getByPlaceholderText(
			get(t)("chat.messagePlaceholder"),
		) as HTMLTextAreaElement;
	}

	function savedLandingChat(draft: Partial<ConversationDraft> | null) {
		return {
			conversation: {
				id: "landing-1",
				title: "New Conversation",
				projectId: null,
				memoryIncognito: false,
			},
			messages: [],
			generatedFiles: [],
			draft: draft && {
				conversationId: "landing-1",
				draftText: "",
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
				pendingSkill: null,
				updatedAt: 1_700_000_000_000,
				...draft,
			},
		};
	}

	// A draft is saved under the landing page's own chat, which Home finds by
	// the id its session remembers.
	function saveLandingDraft(draft: Partial<ConversationDraft> | null) {
		setLandingDraftConversationId("landing-1");
		fetchConversationDetailMock.mockResolvedValue(savedLandingChat(draft));
	}

	function writesToTheServer() {
		return requests.filter((request) => request.method !== "GET");
	}

	function messagesHandedToAChat() {
		return Object.keys(sessionStorage).filter((key) =>
			key.startsWith("pending-chat-message:"),
		);
	}

	// Long enough for anything Home would still do on its own to have been done.
	async function settle() {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}

	beforeEach(() => {
		vi.clearAllMocks();
		fetchConversationDetailMock.mockReset();
		uiLanguage.set("en");
		gotoMock.mockResolvedValue(undefined);
		sessionStorage.clear();
		clearToasts();
		requests.length = 0;
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({ url: String(input), method: init?.method ?? "GET" });
				throw new TypeError("No network in this test");
			},
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		clearToasts();
	});

	it("puts a waiting example in the empty Home box without sending it", async () => {
		storeHomeComposerSeed(example);

		renderHome();

		// In the box itself, not only in Home's copy of the draft.
		await waitFor(() => expect(landingBox()).toHaveValue(example));
		// With the caret in it, ready for the person to change the words.
		expect(landingBox()).toHaveFocus();
		// Nothing left the page: no chat was made for it, no message was handed
		// on to one, and nothing was written to the server.
		await settle();
		expect(messagesHandedToAChat()).toEqual([]);
		expect(gotoMock).not.toHaveBeenCalled();
		expect(writesToTheServer()).toEqual([]);
		expect(get(toasts)).toEqual([]);
		// And the example is taken: it does not wait for the next visit.
		expect(consumeHomeComposerSeed()).toBeNull();
	});

	it("keeps an unsent Home draft and says the example was not added", async () => {
		saveLandingDraft({ draftText: "my words" });
		storeHomeComposerSeed(example);

		renderHome();

		await waitFor(() => expect(get(toasts)).toHaveLength(1));
		expect(get(toasts)[0]).toMatchObject({
			type: "success",
			message: get(t)("guide.tryItDraftKept"),
		});
		// The person's words are in the box, and the example never was.
		await settle();
		expect(landingBox()).toHaveValue("my words");
		expect(writesToTheServer()).toEqual([]);
		// The example is dropped, not left waiting to surprise a later visit.
		expect(consumeHomeComposerSeed()).toBeNull();
	});

	it("says nothing about a draft when no example is waiting", async () => {
		saveLandingDraft({ draftText: "my words" });

		renderHome();

		await waitFor(() => expect(landingBox()).toHaveValue("my words"));
		await settle();
		expect(get(toasts)).toEqual([]);
	});

	it("leaves a waiting example alone on a project page", async () => {
		storeHomeComposerSeed(example);

		render(HomeSurface, {
			mode: {
				kind: "project",
				project: { id: "project-1", name: "Vienna trip" },
				chatCount: 1,
				lastActivityAt: null,
			},
			recent: [],
		});

		const projectBox = screen.getByPlaceholderText(
			get(t)("projects.startChatPlaceholder", { name: "Vienna trip" }),
		);
		await settle();
		expect(projectBox).toHaveValue("");
		expect(get(toasts)).toEqual([]);
		// Still waiting, for the Home page it was left for.
		expect(consumeHomeComposerSeed()).toBe(example);
	});

	it("treats a saved draft with nothing in it as no draft", async () => {
		saveLandingDraft({ draftText: "   " });
		storeHomeComposerSeed(example);

		renderHome();

		await waitFor(() => expect(landingBox()).toHaveValue(example));
		await settle();
		// There was nothing to protect, so there is nothing to apologise for.
		expect(get(toasts)).toEqual([]);
	});

	// The composer takes a saved draft that arrives after it opened only when the
	// draft has words, so a draft with none is not on screen. It has something
	// all the same, and the example is what gives it words.
	it("puts the example beside a saved file that has no words yet", async () => {
		saveLandingDraft({
			draftText: "",
			selectedAttachmentIds: ["artifact-menu"],
			selectedAttachments: [
				{
					artifact: {
						id: "artifact-menu",
						type: "source_document",
						retrievalClass: "durable",
						name: "menu.pdf",
						mimeType: "application/pdf",
						sizeBytes: 7,
						conversationId: "landing-1",
						summary: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					promptReady: true,
					promptArtifactId: "normalized-menu",
					readinessError: null,
				},
			],
		});
		storeHomeComposerSeed(example);

		renderHome();

		// What the person sees: the example in the box, with the caret in it and
		// the file still on the composer.
		await waitFor(() => expect(landingBox()).toHaveValue(example));
		expect(landingBox()).toHaveFocus();
		expect(screen.getByTestId("composer-chip-attachment")).toHaveTextContent(
			"menu.pdf",
		);
		// There was no message to protect, so nothing is said about one, and
		// nothing was written to the server.
		await settle();
		expect(get(toasts)).toEqual([]);
		expect(writesToTheServer()).toEqual([]);
	});

	it("puts the example into a saved draft that holds only Atlas mode", async () => {
		saveLandingDraft({
			draftText: "",
			atlasMode: true,
			atlasProfile: "in-depth",
			clientAtlasTurnId: "atlas-turn-1",
		});
		storeHomeComposerSeed(example);

		renderHome();

		await waitFor(() => expect(landingBox()).toHaveValue(example));
		// Atlas mode stays on, at the depth it was left at and not at its default.
		expect(screen.getByTestId("composer-chip-atlas")).toHaveTextContent(
			get(t)("composerTools.atlasInDepth"),
		);
		await settle();
		expect(get(toasts)).toEqual([]);
		expect(writesToTheServer()).toEqual([]);
	});

	it("still adds the example when the saved draft cannot be read", async () => {
		setLandingDraftConversationId("landing-1");
		fetchConversationDetailMock.mockRejectedValue(new Error("Not found"));
		storeHomeComposerSeed(example);

		renderHome();

		await waitFor(() => expect(landingBox()).toHaveValue(example));
		expect(get(toasts)).toEqual([]);
	});

	it("says nothing when the page is left before the saved draft has been read", async () => {
		let answerTheRead: (detail: unknown) => void = () => undefined;
		setLandingDraftConversationId("landing-1");
		fetchConversationDetailMock.mockReturnValue(
			new Promise((resolve) => {
				answerTheRead = resolve;
			}),
		);
		storeHomeComposerSeed(example);

		const { unmount } = renderHome();
		unmount();
		await tick();
		answerTheRead(savedLandingChat({ draftText: "my words" }));
		await settle();

		// A toast now would land on whatever page the person went to.
		expect(get(toasts)).toEqual([]);
	});
});

// The Feature Guide's Show me asks for a control by name and the control that
// carries the name rings itself. Home carries the mask button and the greeting
// band, and through its composer the Thinking button and the rows of the "+"
// menu. The phone header has a twin of the mask button, so a test here renders
// the header beside the surface too.
describe("HomeSurface and the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		fetchConversationDetailMock.mockReset();
		uiLanguage.set("en");
		gotoMock.mockResolvedValue(undefined);
		sessionStorage.clear();
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
		landingIncognitoArmed.set(false);
		landingIncognitoArmVisible.set(false);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
		landingIncognitoArmed.set(false);
		landingIncognitoArmVisible.set(false);
	});

	it("rings the incognito button when Show me asks for it", () => {
		requestSpotlight("home.incognito");

		renderHome();

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("incognito-arm")).toHaveClass("spotlight-ring");
	});

	it("rings the greeting band when Show me asks for Home", () => {
		requestSpotlight("home.home");

		const { container } = renderHome();

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(container.querySelector(".home-band")).toHaveClass("spotlight-ring");
		expect(screen.getByTestId("incognito-arm")).not.toHaveClass(
			"spotlight-ring",
		);
	});

	it("opens the + menu and rings its Library row when Show me asks for it", async () => {
		requestSpotlight("composer.library");

		renderHome();

		await waitFor(() =>
			expect(screen.getByTestId("composer-tools-menu")).toBeInTheDocument(),
		);
		expect(screen.getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("composer-menu-library")).toHaveClass(
			"spotlight-ring",
		);
	});

	// Home reads the landing page's saved draft from the server after it opens,
	// and a draft that is applied shuts the menu. It must not shut the menu Show
	// me has just opened, with the row's ring still waiting for its frame.
	it("keeps the menu open when the saved Home draft is read after it opened", async () => {
		let answerTheRead: (detail: unknown) => void = () => undefined;
		setLandingDraftConversationId("landing-1");
		fetchConversationDetailMock.mockReturnValue(
			new Promise((resolve) => {
				answerTheRead = resolve;
			}),
		);
		requestSpotlight("composer.library");

		renderHome();
		await waitFor(() =>
			expect(screen.getByTestId("composer-tools-trigger")).toHaveAttribute(
				"aria-expanded",
				"true",
			),
		);
		answerTheRead({
			conversation: {
				id: "landing-1",
				title: "New Conversation",
				projectId: null,
				memoryIncognito: false,
			},
			messages: [],
			generatedFiles: [],
			draft: {
				conversationId: "landing-1",
				draftText: "my words",
				selectedAttachmentIds: [],
				selectedAttachments: [],
				selectedLinkedSources: [],
				pendingSkill: null,
				updatedAt: 1_700_000_000_000,
			},
		});
		await waitFor(() =>
			expect(
				screen.getByPlaceholderText(get(t)("chat.messagePlaceholder")),
			).toHaveValue("my words"),
		);

		expect(screen.getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("composer-menu-library")).toHaveClass(
			"spotlight-ring",
		);
	});

	it("opens the + menu and rings its Atlas row when Atlas is offered", async () => {
		requestSpotlight("composer.atlas");

		render(HomeSurface, {
			mode: { kind: "home" },
			recent: [],
			atlasAvailability: { enabled: true, configured: true, reasonCode: null },
		});

		await waitFor(() =>
			expect(screen.getByTestId("composer-menu-atlas")).toBeInTheDocument(),
		);
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("composer-menu-atlas")).toHaveClass(
			"spotlight-ring",
		);
		expect(get(spotlightRequest)).toBeNull();
	});

	it("rings the Thinking button on the bar without opening the menu", async () => {
		requestSpotlight("composer.thinking");

		renderHome();
		await tick();

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("thinking-bar-toggle")).toHaveClass(
			"spotlight-ring",
		);
		expect(screen.getByTestId("composer-tools-trigger")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	// The mask button is drawn twice: here, for a desktop window, and in the
	// phone header (`lg:hidden` on the header, `display: none` below 1024px on
	// this one). Both carry the id, and the one that has no layout leaves the
	// request for the one that has. jsdom has no layout, so the test says which
	// copy is on screen.
	describe("with the phone header's twin of the mask button", () => {
		function renderWithHeader(hidden: "header" | "home") {
			const withLayout = Element.prototype.getClientRects;
			Element.prototype.getClientRects = function (this: Element) {
				const insideHidden =
					hidden === "header"
						? this.closest("header") !== null
						: this.closest(".incognito-arm-wrap") !== null;
				return insideHidden
					? ([] as unknown as DOMRectList)
					: withLayout.call(this);
			};
			render(Header, {});
			return renderHome();
		}

		it("rings this one on a desktop window, where the header is not shown", async () => {
			requestSpotlight("home.incognito");

			renderWithHeader("header");
			await tick();

			expect(screen.getByTestId("incognito-arm-phone")).toBeInTheDocument();
			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(screen.getByTestId("incognito-arm")).toHaveClass("spotlight-ring");
			expect(screen.getByTestId("incognito-arm-phone")).not.toHaveClass(
				"spotlight-ring",
			);
		});

		it("rings the header's on a phone, where this one is not shown", async () => {
			requestSpotlight("home.incognito");

			renderWithHeader("home");
			await tick();

			expect(screen.getByTestId("incognito-arm-phone")).toBeInTheDocument();
			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(screen.getByTestId("incognito-arm-phone")).toHaveClass(
				"spotlight-ring",
			);
			expect(screen.getByTestId("incognito-arm")).not.toHaveClass(
				"spotlight-ring",
			);
		});
	});
});
