import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import {
	pendingSpotlight,
	requestSpotlight,
	spotlightRequest,
} from "$lib/stores/spotlight";
import {
	landingIncognitoArmed,
	landingIncognitoArmVisible,
	searchModalOpenRequested,
} from "$lib/stores/ui";
import Header from "./Header.svelte";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
}));

const { logoutMock } = vi.hoisted(() => ({ logoutMock: vi.fn() }));

vi.mock("$lib/client/api/auth", () => ({ logout: logoutMock }));

// The confirm dialog the log-out button opens reads other helpers of this
// module too, so only the store is replaced.
vi.mock("$lib/utils/viewport.svelte", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/utils/viewport.svelte")>()),
	viewportStore: { touch: false, tier: "phone" },
}));

describe("Header — mobile menu Search entry (Task 6 / A3)", () => {
	beforeEach(() => {
		searchModalOpenRequested.set(false);
	});

	async function openMobileMenu() {
		render(Header, {});
		await fireEvent.click(
			screen.getByRole("button", { name: "Open user menu" }),
		);
	}

	it("shows a Search row in the mobile header menu", async () => {
		await openMobileMenu();

		expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
	});

	it("requests Workspace Search open and closes the menu when Search is clicked", async () => {
		await openMobileMenu();
		expect(get(searchModalOpenRequested)).toBe(false);

		await fireEvent.click(screen.getByRole("button", { name: "Search" }));

		expect(get(searchModalOpenRequested)).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Search" }),
		).not.toBeInTheDocument();
	});
});

// Incognito, one-way (docs/plans/incognito-one-way-spec.md §2). The phone
// header's mask button mirrors the landing page's own visibility rule
// (landing route, no conversation yet) via the shared
// landingIncognitoArmVisible store, and arms the SAME landingIncognitoArmed
// store the desktop button arms.
describe("Header — incognito", () => {
	beforeEach(() => {
		landingIncognitoArmed.set(false);
		landingIncognitoArmVisible.set(false);
	});

	it("draws no mask button when the landing page has not asked for one", () => {
		render(Header, {});

		expect(screen.queryByTestId("incognito-arm-phone")).not.toBeInTheDocument();
	});

	it("draws the mask button once the landing page says it is visible, and arms the shared flag", async () => {
		landingIncognitoArmVisible.set(true);
		render(Header, {});

		const button = screen.getByTestId("incognito-arm-phone");
		expect(button).toBeInTheDocument();
		expect(get(landingIncognitoArmed)).toBe(false);

		await fireEvent.click(button);

		expect(get(landingIncognitoArmed)).toBe(true);
	});

	it("shows the mask mark before the title for an incognito conversation", () => {
		render(Header, {
			conversationTitle: "Salary negotiation script",
			conversationIsIncognito: true,
		});

		expect(
			screen.getByLabelText("Incognito — not remembered"),
		).toBeInTheDocument();
	});

	it("draws no mask mark for a normal conversation", () => {
		render(Header, {
			conversationTitle: "Q3 budget reconciliation",
			conversationIsIncognito: false,
		});

		expect(
			screen.queryByLabelText("Incognito — not remembered"),
		).not.toBeInTheDocument();
	});
});

// The Feature Guide's Show me for the mask button names it `home.incognito`,
// and the button on the landing page carries the same name (`HomeSurface`).
// This one is the phone's: the header is `lg:hidden`, so on a desktop window it
// has no layout and leaves the request for the landing page's own button.
describe("Header — the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	beforeEach(() => {
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
		landingIncognitoArmed.set(false);
		landingIncognitoArmVisible.set(true);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
		landingIncognitoArmVisible.set(false);
	});

	it("rings the phone's incognito button when Show me asks for it", () => {
		requestSpotlight("home.incognito");

		render(Header, {});

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("incognito-arm-phone")).toHaveClass(
			"spotlight-ring",
		);
	});

	// The landing page decides when the button is drawn (it sets the store when
	// it mounts), so on the way from the guide the request is made before the
	// button exists.
	it("rings the button when the landing page draws it after the request", async () => {
		landingIncognitoArmVisible.set(false);
		render(Header, {});
		expect(screen.queryByTestId("incognito-arm-phone")).toBeNull();

		requestSpotlight("home.incognito");
		landingIncognitoArmVisible.set(true);
		await tick();

		expect(get(spotlightRequest)).toBeNull();
		vi.advanceTimersToNextFrame();
		expect(screen.getByTestId("incognito-arm-phone")).toHaveClass(
			"spotlight-ring",
		);
	});

	it("leaves the request alone while the header is not on screen", () => {
		const withLayout = Element.prototype.getClientRects;
		Element.prototype.getClientRects = function (this: Element) {
			return this.closest("header")
				? ([] as unknown as DOMRectList)
				: withLayout.call(this);
		};
		requestSpotlight("home.incognito");

		render(Header, {});
		vi.advanceTimersToNextFrame();

		expect(pendingSpotlight(get(spotlightRequest))).toBe("home.incognito");
		expect(screen.getByTestId("incognito-arm-phone")).not.toHaveClass(
			"spotlight-ring",
		);
	});

	it("leaves a request for another control alone", () => {
		requestSpotlight("home.home");

		render(Header, {});
		vi.advanceTimersToNextFrame();

		expect(pendingSpotlight(get(spotlightRequest))).toBe("home.home");
		expect(screen.getByTestId("incognito-arm-phone")).not.toHaveClass(
			"spotlight-ring",
		);
	});
});

// ADR-0043: "Logout requires confirmation". The sidebar asks first; the phone
// header's menu used to end the session on the first press.
describe("Header — log out", () => {
	beforeEach(() => {
		logoutMock.mockReset();
		logoutMock.mockResolvedValue(undefined);
		// jsdom has no Web Animations API, so report reduced motion and let the
		// dialog's outro finish.
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: true,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
	});

	async function pressLogout() {
		render(Header, {});
		await fireEvent.click(
			screen.getByRole("button", { name: "Open user menu" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Logout" }));
	}

	it("asks before it ends the session, as the sidebar does", async () => {
		await pressLogout();

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Log out?")).toBeInTheDocument();
		expect(logoutMock).not.toHaveBeenCalled();
	});

	it("ends the session once it is confirmed", async () => {
		await pressLogout();

		await fireEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Log out",
			}),
		);

		await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
	});

	it("keeps the session when it is cancelled", async () => {
		await pressLogout();

		await fireEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Cancel",
			}),
		);

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(logoutMock).not.toHaveBeenCalled();
	});
});
