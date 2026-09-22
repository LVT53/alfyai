import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";

import SessionExpiredNotice from "./SessionExpiredNotice.svelte";

describe("SessionExpiredNotice", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("stays hidden while the session is live", () => {
		render(SessionExpiredNotice, {
			visible: false,
			onSignIn: vi.fn(),
		});

		expect(
			screen.queryByTestId("session-expired-notice"),
		).not.toBeInTheDocument();
	});

	it("says what happened and offers the way back", () => {
		render(SessionExpiredNotice, {
			visible: true,
			onSignIn: vi.fn(),
		});

		expect(screen.getByTestId("session-expired-notice")).toBeVisible();
		expect(
			screen.getByRole("status", { name: "You have been signed out" }),
		).toBeVisible();
		expect(
			screen.getByText(/out of reach until you sign in again/),
		).toBeVisible();
		expect(screen.getByRole("button", { name: /Sign in again/ })).toBeVisible();
	});

	it("hands the sign-in press back to the shell", async () => {
		const onSignIn = vi.fn();
		render(SessionExpiredNotice, { visible: true, onSignIn });

		await userEvent.click(screen.getByTestId("session-expired-sign-in"));

		expect(onSignIn).toHaveBeenCalledOnce();
	});

	it("uses Hungarian copy when the UI language is Hungarian", () => {
		uiLanguage.set("hu");

		render(SessionExpiredNotice, {
			visible: true,
			onSignIn: vi.fn(),
		});

		expect(
			screen.getByRole("status", { name: "Kiléptettünk a fiókodból" }),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: /Bejelentkezés újra/ }),
		).toBeVisible();
	});
});
