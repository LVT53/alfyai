import { expect, test } from "@playwright/test";
import { login, waitForHydration } from "./helpers";

/**
 * What the app does once the server stops accepting this tab's session.
 *
 * Before the session gate learned to answer API calls in their own language,
 * an expired session was silent: every call was redirected to the login page,
 * `fetch` followed the redirect, and callers parsed HTML as their payload —
 * models vanished, lists emptied, sends failed on a parse error, and nothing
 * on screen said why.
 */

/** Replaces the good cookie with one the server will refuse, as expiry does. */
async function killSessionServerSide(page: import("@playwright/test").Page) {
	await page.context().addCookies([
		{
			name: "session",
			value: "expired-session-token-for-e2e",
			url: page.url(),
		},
	]);
}

test.describe("Expired session", () => {
	test("puts a row at the top of the app and says so when an action is refused", async ({
		page,
	}) => {
		await login(page);
		await waitForHydration(page);

		// Nothing to see while the session is good.
		await expect(page.getByTestId("session-expired-notice")).toBeHidden();

		await killSessionServerSide(page);

		// A real action, in the page the user is already looking at: opening
		// workspace search runs a search against the API.
		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();

		const notice = page.getByTestId("session-expired-notice");
		await expect(notice).toBeVisible({ timeout: 15000 });
		await expect(notice).toContainText("You have been signed out");
		await expect(
			notice.getByRole("button", { name: /Sign in again/ }),
		).toBeVisible();

		// And the refusal is announced, not just implied by the row.
		await expect(page.getByTestId("toast-entry")).toContainText(
			"Your session has expired",
		);

		// The announcement and the row both want the top of the screen. The
		// toast region starts below the row, or it covers the one button the
		// row exists to offer (this is how it first behaved).
		const noticeBox = await notice.boundingBox();
		const toastBox = await page.getByTestId("toast-region").boundingBox();
		expect(noticeBox).not.toBeNull();
		expect(toastBox).not.toBeNull();
		if (noticeBox && toastBox) {
			expect(toastBox.y).toBeGreaterThanOrEqual(noticeBox.y + noticeBox.height);
		}
	});

	// The other way in, and the other cause: no cookie at all rather than a bad
	// one, and the shell's own background refresh rather than something the
	// user pressed. The shell refreshes the conversation list whenever the
	// window regains focus — an ordinary API call through the shared HTTP
	// layer, and the most likely way a user actually meets an expired session.
	test("raises the row when the shell's own refresh is refused", async ({
		page,
		context,
	}) => {
		await login(page);
		await waitForHydration(page);

		await context.clearCookies();
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));

		await expect(page.getByTestId("session-expired-notice")).toBeVisible({
			timeout: 15000,
		});
		// And the tab stays where it is. A background refresh being refused is
		// not a reason to throw away whatever the user was in the middle of —
		// signing in from another tab heals this one on the next request.
		await expect(page).not.toHaveURL(/\/login/);
	});

	test("sends the user to a login screen that explains itself", async ({
		page,
	}) => {
		await login(page);
		await waitForHydration(page);
		await killSessionServerSide(page);

		await page
			.getByRole("button", { name: "Search conversations and documents" })
			.click();
		await expect(page.getByTestId("session-expired-notice")).toBeVisible({
			timeout: 15000,
		});

		// Back out of the search the refusal came from, the way the user would.
		// Its backdrop covers the whole viewport, the row included, until the
		// modal has actually gone.
		await page.keyboard.press("Escape");
		await expect(page.locator(".search-portal-backdrop")).toHaveCount(0);

		// Pressed with the announcement still on screen, deliberately: the row's
		// button has to stay clickable while a toast is up.
		await expect(page.getByTestId("toast-entry")).toBeVisible();
		await page.getByTestId("session-expired-sign-in").click();

		await expect(page).toHaveURL(/\/login\?session=expired/);
		await expect(page.getByTestId("login-session-expired")).toContainText(
			"Your session has expired",
		);
	});

	test("explains itself on a page navigation made with a dead session", async ({
		page,
	}) => {
		await login(page);
		await killSessionServerSide(page);

		await page.goto("/", { waitUntil: "domcontentloaded" });

		await expect(page).toHaveURL(/\/login\?session=expired/);
		await expect(page.getByTestId("login-session-expired")).toBeVisible();
	});

	test("does not explain anything to a visitor who was never signed in", async ({
		page,
	}) => {
		await page.context().clearCookies();

		await page.goto("/", { waitUntil: "domcontentloaded" });

		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByTestId("login-session-expired")).toBeHidden();
	});
});
