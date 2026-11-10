import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { get, readable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import {
	conversations,
	markConversationAtlasBadgeSeen,
} from "$lib/stores/conversations";
import { uiLanguage } from "$lib/stores/settings";
import {
	pendingSpotlight,
	requestSpotlight,
	SPOTLIGHT_REQUEST_TTL_MS,
	spotlightRequest,
} from "$lib/stores/spotlight";
import {
	currentConversationId,
	sidebarCollapsed,
	sidebarOpen,
} from "$lib/stores/ui";
import Sidebar from "./Sidebar.svelte";

// Deterministic desktop/non-touch viewport so the expanded search pill (and
// its kbd hint chip) render regardless of the host machine's jsdom defaults.
// `initViewportTracking` is a spy here, so a test can ask whether the sidebar
// started it; `Sidebar.viewport.test.ts` runs the real store.
const mockViewportStore = { touch: false, tier: "desktop" };
const { initViewportTrackingMock } = vi.hoisted(() => ({
	initViewportTrackingMock: vi.fn(),
}));
vi.mock("$lib/utils/viewport.svelte", () => ({
	get viewportStore() {
		return mockViewportStore;
	},
	isTouchDevice: () => false,
	initViewportTracking: initViewportTrackingMock,
}));

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

vi.mock("$app/stores", () => ({
	navigating: readable(null),
	page: readable({ url: new URL("http://localhost/") }),
}));

// `page` of `$app/state` is a reactive object, read through runes only. A
// `SvelteURL` is reactive in the same way, so a test can move it to another path
// after the sidebar is drawn and see whether the sidebar follows.
vi.mock("$app/state", async () => {
	const { SvelteURL } = await import("svelte/reactivity");
	return { page: { url: new SvelteURL("http://localhost/") } };
});

vi.mock("$lib/client/api/workspace-search", () => ({
	fetchWorkspaceSearch: vi.fn().mockResolvedValue({
		mode: "default",
		query: "",
		conversations: [],
		documents: [],
	}),
}));

function conv(id: string, unseen = false) {
	return {
		id,
		title: id,
		updatedAt: 1,
		atlasBadge: unseen
			? { jobId: `job-${id}`, status: "succeeded", completedAt: 5 }
			: undefined,
	} as never;
}

describe("Sidebar — Cmd/Ctrl+K Workspace Search shortcut (Task 6 / A3)", () => {
	beforeEach(() => {
		// Expanded sidebar so the search pill (and its kbd hint) render instead
		// of the icon-only collapsed rail.
		sidebarCollapsed.set(false);
	});

	it("opens Workspace Search on Ctrl+K from anywhere in the app", async () => {
		render(Sidebar, { open: true });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await fireEvent.keyDown(window, { key: "k", ctrlKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
	});

	it("opens Workspace Search on Cmd+K (metaKey, mac)", async () => {
		render(Sidebar, { open: true });

		await fireEvent.keyDown(window, { key: "k", metaKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
	});

	it("opens Workspace Search on Ctrl+K even when a text input is focused", async () => {
		// A modifier chord never collides with ordinary typing, unlike the bare
		// `/` shortcut — the chat composer textarea is the primary focus target
		// on this page, so ⌘K/Ctrl+K must still fire from inside it (Slack,
		// Linear, Notion, VS Code all open their palette from a focused input).
		render(Sidebar, { open: true });
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		await fireEvent.keyDown(input, { key: "k", ctrlKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
		document.body.removeChild(input);
	});

	it("opens Workspace Search on Ctrl+K even when focus is inside a contenteditable element", async () => {
		render(Sidebar, { open: true });
		const editable = document.createElement("div");
		// jsdom doesn't implement the contenteditable editing spec (setting the
		// `contentEditable` attribute never makes `isContentEditable` true), so
		// the getter is stubbed directly to exercise that exact branch.
		Object.defineProperty(editable, "isContentEditable", {
			value: true,
			configurable: true,
		});
		document.body.appendChild(editable);
		editable.focus();

		await fireEvent.keyDown(editable, { key: "k", ctrlKey: true });

		expect(
			screen.getByRole("dialog", { name: "Search workspace" }),
		).toBeInTheDocument();
		document.body.removeChild(editable);
	});

	it("does not call preventDefault again while the modal is already open", async () => {
		render(Sidebar, { open: true });

		await fireEvent.keyDown(window, { key: "k", ctrlKey: true });
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		const notPrevented = await fireEvent.keyDown(window, {
			key: "k",
			ctrlKey: true,
		});

		expect(notPrevented).toBe(true);
	});

	it("shows a Ctrl+K hint chip inside the search pill", () => {
		render(Sidebar, { open: true });

		expect(screen.getByTestId("search-shortcut-hint")).toHaveTextContent(
			"Ctrl+K",
		);
	});

	it("shows a ⌘K hint chip on a mac platform", () => {
		const originalDescriptor = Object.getOwnPropertyDescriptor(
			window.navigator,
			"platform",
		);
		Object.defineProperty(window.navigator, "platform", {
			value: "MacIntel",
			configurable: true,
		});

		try {
			render(Sidebar, { open: true });
			expect(screen.getByTestId("search-shortcut-hint")).toHaveTextContent(
				"⌘K",
			);
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(window.navigator, "platform", originalDescriptor);
			}
		}
	});
});

describe("Sidebar — collapsed-rail active-conversation indicator (Task 11 / A4, ADR-0043 #3)", () => {
	beforeEach(() => {
		// Force desktop tier so `isCollapsed` can be driven purely by
		// `sidebarCollapsed` (precedent: viewport.test.ts's tier stubbing).
		mockViewportStore.tier = "desktop";
	});

	afterEach(() => {
		sidebarCollapsed.set(false);
		currentConversationId.set(null);
	});

	it("shows no dot when collapsed with a chat open but nothing unseen", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");
		conversations.set([conv("conversation-123")]);

		render(Sidebar, { open: true });

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
		const logoButton = screen.getByTestId("sidebar-logo");
		expect(logoButton).toHaveAttribute("aria-label", "Expand sidebar");
		expect(logoButton).toHaveAttribute("title", "Expand sidebar");
	});

	it("shows a decorative dot on the logo button when another conversation has an unseen badge", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");
		conversations.set([conv("conversation-123"), conv("other", true)]);

		render(Sidebar, { open: true });

		const indicator = screen.getByTestId("unseen-activity-indicator");
		expect(indicator).toHaveAttribute("aria-hidden", "true");
		expect(indicator).not.toHaveAttribute("role");
		expect(indicator).not.toHaveAttribute("aria-label");
		const logoButton = screen.getByTestId("sidebar-logo");
		expect(logoButton).toContainElement(indicator);
		expect(logoButton).toHaveAttribute(
			"aria-label",
			"Expand sidebar — new activity",
		);
	});

	it("drops the dot once the badge is seen", async () => {
		sidebarCollapsed.set(true);
		conversations.set([conv("other", true)]);

		render(Sidebar, { open: true });
		expect(screen.getByTestId("unseen-activity-indicator")).toBeInTheDocument();

		markConversationAtlasBadgeSeen("other");
		await tick();

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
	});

	it("does not count a badge on the conversation being viewed", async () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("other");
		conversations.set([conv("other", true)]);

		render(Sidebar, { open: true });
		await tick();

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
	});

	it("does not show the indicator (or reintroduce it as a border) on the New Chat button", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true });

		const newChatButton = screen.getByTestId("new-conversation");
		expect(
			within(newChatButton).queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
		expect(newChatButton).not.toHaveClass("active-conversation-dot");
	});

	it("still does not render the conversation list when collapsed", () => {
		sidebarCollapsed.set(true);
		currentConversationId.set("conversation-123");

		render(Sidebar, { open: true, conversationsData: [] });

		// The "Chats" section header is unconditionally rendered by
		// ConversationList (ADR-0043 #3: "the Chats header never vanishes"),
		// so its absence proves the list itself isn't mounted.
		expect(screen.queryByText("Chats")).not.toBeInTheDocument();
	});

	it("does not show the corner dot when expanded, even with an unseen badge", () => {
		sidebarCollapsed.set(false);
		currentConversationId.set("conversation-123");
		conversations.set([conv("other", true)]);

		render(Sidebar, { open: true });

		expect(
			screen.queryByTestId("unseen-activity-indicator"),
		).not.toBeInTheDocument();
	});
});

// The Feature Guide's Show me for the sidebar's Search and Projects. The guide
// stays on its page for these two (the sidebar is on every page), so the
// sidebar has to be there to be rung: below desktop it is a drawer, and on a
// collapsed desktop sidebar the rail has no Projects.
describe("Sidebar — the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	const searchPill = () =>
		screen.getByRole("button", { name: "Search conversations and documents" });
	const projectsHeader = () => screen.getByTestId("sidebar-projects-header");
	const ringing = () => [...document.querySelectorAll(".spotlight-ring")];

	beforeEach(() => {
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		// Every element has layout, as the drawer's contents do in a real
		// browser while it is shut: it is hidden with opacity, a transform and
		// pointer-events, none of which takes the layout away.
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
		conversations.set([]);
		currentConversationId.set(null);
		mockViewportStore.tier = "desktop";
		sidebarOpen.set(false);
		sidebarCollapsed.set(false);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
		mockViewportStore.tier = "desktop";
		sidebarOpen.set(false);
		sidebarCollapsed.set(false);
	});

	describe("below desktop, where the sidebar is a drawer", () => {
		beforeEach(() => {
			mockViewportStore.tier = "phone";
		});

		// The drawer is mounted while it is shut, so the pill is in the page with
		// a layout and its marker takes the request the moment the store tells it.
		// An opener that waited for the next update (an `$effect`) would read a
		// request that is already gone, leave the drawer shut and let the ring
		// play on a pill nobody can see.
		it("opens the phone drawer when Show me asks for Search", async () => {
			render(Sidebar, { open: false });

			requestSpotlight("sidebar.search");
			await tick();

			expect(get(sidebarOpen)).toBe(true);
			// The pill took the request, not the sidebar's opener.
			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([searchPill()]);
		});

		it("opens the phone drawer when Show me asks for Projects", async () => {
			render(Sidebar, { open: false });

			requestSpotlight("sidebar.projects");
			await tick();

			expect(get(sidebarOpen)).toBe(true);
			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([projectsHeader()]);
		});

		// A tablet is below desktop too, and its sidebar is the same drawer.
		it.each([
			["Search", "sidebar.search"],
			["Projects", "sidebar.projects"],
		] as const)("opens the drawer on a tablet when Show me asks for %s", async (_name, spotlight) => {
			mockViewportStore.tier = "tablet";
			render(Sidebar, { open: false });

			requestSpotlight(spotlight);
			await tick();

			expect(get(sidebarOpen)).toBe(true);
			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(ringing()).toHaveLength(1);
		});

		it("opens the drawer before a control in it takes the request", () => {
			render(Sidebar, { open: false });
			const waitingWhenOpened: unknown[] = [];
			const open = vi.spyOn(sidebarOpen, "set").mockImplementation((value) => {
				waitingWhenOpened.push([
					value,
					pendingSpotlight(get(spotlightRequest)),
				]);
			});

			try {
				requestSpotlight("sidebar.search");

				// Asked for while the request still waited. The pill's marker takes
				// it next: it is told after this component, which subscribed first.
				expect(waitingWhenOpened).toEqual([[true, "sidebar.search"]]);
			} finally {
				open.mockRestore();
			}
		});

		it("leaves an open drawer open", async () => {
			sidebarOpen.set(true);
			render(Sidebar, { open: true });

			requestSpotlight("sidebar.search");
			await tick();

			expect(get(sidebarOpen)).toBe(true);
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([searchPill()]);
		});

		it("opens nothing for a request for another control", async () => {
			render(Sidebar, { open: false });

			requestSpotlight("composer.atlas");
			await tick();

			expect(get(sidebarOpen)).toBe(false);
			expect(pendingSpotlight(get(spotlightRequest))).toBe("composer.atlas");
		});

		it("opens nothing for a request that has lapsed", async () => {
			render(Sidebar, { open: false });

			requestSpotlight(
				"sidebar.search",
				Date.now() - SPOTLIGHT_REQUEST_TTL_MS - 1,
			);
			await tick();

			expect(get(sidebarOpen)).toBe(false);
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([]);
		});

		it("does not open the drawer again once the person has shut it, and opens it for the next request", async () => {
			// The pill has no layout here, so the request is left waiting, as one
			// is when its control is not on screen (`afterEach` puts the stub back).
			const withLayout = Element.prototype.getClientRects;
			Element.prototype.getClientRects = function (this: Element) {
				return this.closest(".search-pill")
					? ([] as unknown as DOMRectList)
					: withLayout.call(this);
			};
			render(Sidebar, { open: false });
			requestSpotlight("sidebar.search");
			await tick();
			expect(get(sidebarOpen)).toBe(true);
			expect(pendingSpotlight(get(spotlightRequest))).toBe("sidebar.search");

			sidebarOpen.set(false);
			await tick();
			await tick();

			expect(get(sidebarOpen)).toBe(false);

			requestSpotlight("sidebar.search");
			await tick();
			expect(get(sidebarOpen)).toBe(true);
		});

		it("stops listening when the sidebar goes", async () => {
			const { unmount } = render(Sidebar, { open: false });
			unmount();

			requestSpotlight("sidebar.search");
			await tick();

			expect(get(sidebarOpen)).toBe(false);
		});
	});

	describe("on a desktop window", () => {
		it("expands a collapsed sidebar when Show me asks for Projects", async () => {
			sidebarCollapsed.set(true);
			render(Sidebar, { open: true });
			// The rail has no Projects.
			expect(screen.queryByTestId("sidebar-projects-header")).toBeNull();

			requestSpotlight("sidebar.projects");

			expect(get(sidebarCollapsed)).toBe(false);
			// Nothing was there to take the request: the opener only reads it.
			expect(pendingSpotlight(get(spotlightRequest))).toBe("sidebar.projects");

			await tick();

			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([projectsHeader()]);
		});

		it("rings the rail's Search button and leaves the rail as it is", async () => {
			sidebarCollapsed.set(true);
			render(Sidebar, { open: true });

			requestSpotlight("sidebar.search");
			await tick();

			expect(get(sidebarCollapsed)).toBe(true);
			expect(get(sidebarOpen)).toBe(false);
			expect(get(spotlightRequest)).toBeNull();
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([searchPill()]);
			expect(ringing()[0]).not.toHaveClass("search-pill");
		});

		it("rings the search pill and changes nothing else", async () => {
			render(Sidebar, { open: true });

			requestSpotlight("sidebar.search");
			await tick();

			expect(get(sidebarCollapsed)).toBe(false);
			expect(get(sidebarOpen)).toBe(false);
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([searchPill()]);
			expect(searchPill()).toHaveClass("search-pill");
		});

		it("rings the Projects header of the open sidebar and changes nothing else", async () => {
			render(Sidebar, { open: true });

			requestSpotlight("sidebar.projects");
			await tick();

			expect(get(sidebarCollapsed)).toBe(false);
			expect(get(sidebarOpen)).toBe(false);
			vi.advanceTimersToNextFrame();
			expect(ringing()).toEqual([projectsHeader()]);
		});

		it("does not expand the rail for Search or for another control", async () => {
			sidebarCollapsed.set(true);
			render(Sidebar, { open: true });

			requestSpotlight("sidebar.search");
			requestSpotlight("settings.data");
			await tick();

			expect(get(sidebarCollapsed)).toBe(true);
		});

		it("does not expand the rail for a request that has lapsed", async () => {
			sidebarCollapsed.set(true);
			render(Sidebar, { open: true });

			requestSpotlight(
				"sidebar.projects",
				Date.now() - SPOTLIGHT_REQUEST_TTL_MS - 1,
			);
			await tick();

			expect(get(sidebarCollapsed)).toBe(true);
		});
	});
});

// The sidebar's `isDesktop`, and the header's button that opens the drawer, read
// `viewportStore`, which keeps its server-side default ("desktop") until
// `initViewportTracking()` runs. Only the composer and the model selector used to
// call it, so a page without a composer that was loaded directly (a reload of
// Settings, the Knowledge Base or the guide) left a phone's sidebar believing it
// was a desktop one: the header's button did nothing and the guide's Show me found
// no drawer to open. The sidebar starts the tracking itself.
// `Sidebar.viewport.test.ts` runs the real store and shows what that does.
describe("Sidebar — the viewport", () => {
	beforeEach(() => {
		initViewportTrackingMock.mockClear();
	});

	it("starts tracking the viewport when it mounts", async () => {
		render(Sidebar, { open: false });
		await tick();

		expect(initViewportTrackingMock).toHaveBeenCalledTimes(1);
	});

	it("starts it again for a sidebar that is mounted anew (the call is safe to repeat)", async () => {
		// Signing out and in again drops the shell and builds it again. The
		// tracking is the page's, shared with the composer, and `initViewportTracking`
		// registers its listeners once and only refreshes the store on a later call
		// (`viewport.test.ts`), so each sidebar asks and none has to undo anything.
		const first = render(Sidebar, { open: false });
		await tick();
		first.unmount();
		render(Sidebar, { open: false });
		await tick();

		expect(initViewportTrackingMock).toHaveBeenCalledTimes(2);
	});
});

// The Feature Guide's ways in (design 3.1): a "?" beside the version badge in
// the expanded header, a fourth button in the collapsed rail (the rail shows
// only the logo, so the badge and the "?" are gone there), and, on a phone, a
// row in the header's user menu (`Header.test.ts`).
describe("Sidebar — the ? that opens the feature guide", () => {
	const guideButton = () =>
		screen.getByRole("button", { name: "What AlfyAI can do" });
	const appVersion = { compact: "v2.0.1", full: "2.0.1 (abc1234)" };

	beforeEach(() => {
		vi.mocked(goto).mockClear();
		page.url.pathname = "/";
		mockViewportStore.tier = "desktop";
		sidebarOpen.set(false);
		sidebarCollapsed.set(false);
		uiLanguage.set("en");
	});

	afterEach(() => {
		page.url.pathname = "/";
		mockViewportStore.tier = "desktop";
		sidebarOpen.set(false);
		sidebarCollapsed.set(false);
		uiLanguage.set("en");
	});

	describe("beside the version badge", () => {
		// The version arrives after hydration; the "?" must not wait for it.
		it("puts a ? beside the version badge that opens the guide, before the version has loaded", async () => {
			render(Sidebar, { open: true, appVersion: null });

			await fireEvent.click(guideButton());

			expect(goto).toHaveBeenCalledWith("/guide");
		});

		it("sits right after the badge once the version has arrived", () => {
			render(Sidebar, { open: true, appVersion });

			const badge = screen.getByRole("button", { name: "App version v2.0.1" });
			expect(badge.nextElementSibling).toBe(guideButton());
			expect(guideButton().closest(".sidebar-header")).not.toBeNull();
		});

		it("leaves each button its own job: the badge replays the release card, the ? opens the guide", async () => {
			const onAppVersionClick = vi.fn();
			render(Sidebar, { open: true, appVersion, onAppVersionClick });

			await fireEvent.click(
				screen.getByRole("button", { name: "App version v2.0.1" }),
			);
			expect(onAppVersionClick).toHaveBeenCalledTimes(1);
			expect(goto).not.toHaveBeenCalled();

			await fireEvent.click(guideButton());
			expect(goto).toHaveBeenCalledWith("/guide");
			expect(onAppVersionClick).toHaveBeenCalledTimes(1);
		});

		it("is named and titled with the guide's title, in the reader's language", () => {
			const { unmount } = render(Sidebar, { open: true });
			expect(guideButton()).toHaveAttribute("title", "What AlfyAI can do");
			unmount();

			uiLanguage.set("hu");
			render(Sidebar, { open: true });
			const hungarian = screen.getByRole("button", {
				name: "Amit az AlfyAI tud",
			});
			expect(hungarian).toHaveAttribute("title", "Amit az AlfyAI tud");
		});

		it("is drawn once, in the header", () => {
			render(Sidebar, { open: true, appVersion });

			expect(
				screen.getAllByRole("button", { name: "What AlfyAI can do" }),
			).toHaveLength(1);
		});

		// `app.css` forces `.btn-icon-bare` and `.compose-btn` to 44 px under 768 px,
		// which would turn a badge-high circle into a 44 px box and grow the header.
		// Its touch area is a pseudo-element instead.
		it("is not one of the classes that app.css stretches to 44 px on a phone", () => {
			render(Sidebar, { open: true, appVersion });

			expect(guideButton()).not.toHaveClass("btn-icon-bare");
			expect(guideButton()).not.toHaveClass("compose-btn");
		});

		it("closes the phone drawer when it opens the guide", async () => {
			mockViewportStore.tier = "phone";
			sidebarOpen.set(true);
			render(Sidebar, { open: true });

			await fireEvent.click(guideButton());

			expect(goto).toHaveBeenCalledWith("/guide");
			expect(get(sidebarOpen)).toBe(false);
		});

		it("leaves a desktop sidebar as it is when it opens the guide", async () => {
			sidebarOpen.set(true);
			render(Sidebar, { open: true });

			await fireEvent.click(guideButton());

			expect(goto).toHaveBeenCalledWith("/guide");
			expect(get(sidebarOpen)).toBe(true);
		});
	});

	describe("the current page", () => {
		it("marks the ? as the current page on the guide", () => {
			page.url.pathname = "/guide";
			render(Sidebar, { open: true });

			expect(guideButton()).toHaveAttribute("aria-current", "page");
		});

		it.each([
			"/",
			"/knowledge",
			"/settings",
			"/chat/abc",
			"/guidelines",
			"/guide/extra",
		])("does not mark it on %s", (pathname) => {
			page.url.pathname = pathname;
			render(Sidebar, { open: true });

			expect(guideButton()).not.toHaveAttribute("aria-current");
		});

		// `page` is read through runes, so the sidebar, which stays mounted from
		// one page to the next, has to follow it.
		it("follows the page as the person moves to the guide and away from it", async () => {
			render(Sidebar, { open: true });
			expect(guideButton()).not.toHaveAttribute("aria-current");

			page.url.pathname = "/guide";
			await tick();
			expect(guideButton()).toHaveAttribute("aria-current", "page");

			page.url.pathname = "/knowledge";
			await tick();
			expect(guideButton()).not.toHaveAttribute("aria-current");
		});
	});

	describe("in the collapsed rail", () => {
		const knowledgeButton = () =>
			screen.getByRole("button", { name: "Open knowledge base" });

		beforeEach(() => {
			sidebarCollapsed.set(true);
		});

		it("puts a ? in the collapsed rail", async () => {
			render(Sidebar, { open: true, appVersion });

			await fireEvent.click(guideButton());

			expect(goto).toHaveBeenCalledWith("/guide");
		});

		it("is the rail's fourth button, after Knowledge", () => {
			render(Sidebar, { open: true });

			const rail = guideButton().parentElement;
			expect(rail).toHaveClass("collapsed-rail");
			expect(
				within(rail as HTMLElement)
					.getAllByRole("button")
					.map((button) => button.getAttribute("aria-label")),
			).toEqual([
				"New chat",
				"Search conversations and documents",
				"Open knowledge base",
				"What AlfyAI can do",
			]);
			expect(knowledgeButton().nextElementSibling).toBe(guideButton());
		});

		it("is named and titled with the guide's title, and is the only one", () => {
			render(Sidebar, { open: true, appVersion });

			expect(guideButton()).toHaveAttribute("title", "What AlfyAI can do");
			expect(
				screen.getAllByRole("button", { name: "What AlfyAI can do" }),
			).toHaveLength(1);
			// The badge is gone with the rest of the expanded header.
			expect(
				screen.queryByRole("button", { name: "App version v2.0.1" }),
			).toBeNull();
		});

		it("is styled like the rail's other buttons", () => {
			render(Sidebar, { open: true });

			for (const className of ["compose-btn", "h-9", "w-9", "rounded-lg"]) {
				expect(guideButton()).toHaveClass(className);
				expect(knowledgeButton()).toHaveClass(className);
			}
		});

		it("marks the current page on the guide, as the ? beside the badge does", () => {
			page.url.pathname = "/guide";
			render(Sidebar, { open: true });

			expect(guideButton()).toHaveAttribute("aria-current", "page");
			expect(knowledgeButton()).not.toHaveAttribute("aria-current");
		});
	});
});
