import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";

const mockPage = vi.hoisted(() => ({
	url: new URL("http://localhost/login"),
}));
const mockGoto = vi.hoisted(() => vi.fn());
const mockInvalidateAll = vi.hoisted(() => vi.fn());
const mockLogin = vi.hoisted(() => vi.fn());
const mockVerify = vi.hoisted(() => vi.fn());

vi.mock("$app/state", () => ({ page: mockPage }));
vi.mock("$app/navigation", () => ({
	goto: mockGoto,
	invalidateAll: mockInvalidateAll,
}));
vi.mock("$lib/client/api/auth", () => ({
	login: mockLogin,
	verifyTwoStepSignIn: mockVerify,
}));
vi.mock("$lib/client/session-boundary", () => ({
	clearClientAccountState: vi.fn(),
}));

import LoginPage from "./+page.svelte";

function renderPage() {
	return render(LoginPage);
}

async function submitPassword(email = "dora@example.com", password = "pw") {
	await fireEvent.input(screen.getByLabelText("Email address"), {
		target: { value: email },
	});
	await fireEvent.input(screen.getByLabelText("Password"), {
		target: { value: password },
	});
	await fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
}

async function typeCode(code: string) {
	const input = screen.getByLabelText("Code");
	await fireEvent.input(input, { target: { value: code } });
	return input;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockPage.url = new URL("http://localhost/login");
	mockLogin.mockResolvedValue({
		user: { id: "u1", email: "dora@example.com", displayName: "Dora" },
	});
	mockVerify.mockResolvedValue({
		ok: true,
		usedBackupCode: false,
		backupCodesLeft: 10,
	});
});

describe("the sign-in card's second step", () => {
	it("after a twoStep answer the card asks for the code", async () => {
		mockLogin.mockResolvedValue({ twoStep: true });
		renderPage();

		await submitPassword();

		expect(await screen.findByText("Enter your code")).toBeInTheDocument();
		expect(screen.getByLabelText("Code")).toBeInTheDocument();
		// The password fields are gone: the same card changed in place.
		expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
	});

	it("?step=two-step opens the code step directly", () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		renderPage();

		expect(screen.getByText("Enter your code")).toBeInTheDocument();
		expect(screen.getByLabelText("Code")).toBeInTheDocument();
	});

	it("the code field is one input with a one-time-code autocomplete and a numeric keyboard", () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		renderPage();

		const input = screen.getByLabelText("Code");
		expect(input).toHaveAttribute("autocomplete", "one-time-code");
		expect(input).toHaveAttribute("inputmode", "numeric");
		expect(input).toHaveAttribute("maxlength", "6");
	});

	it("six digits submit by themselves, once", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		renderPage();

		const input = await typeCode("123456");

		await waitFor(() =>
			expect(mockVerify).toHaveBeenCalledWith({ code: "123456" }),
		);
		expect(mockVerify).toHaveBeenCalledTimes(1);
		// The same six digits arriving again (an autofill event, a repeated
		// input) do not submit a second attempt.
		await fireEvent.input(input, { target: { value: "123456" } });
		expect(mockVerify).toHaveBeenCalledTimes(1);
	});

	it("only digits reach the code field", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		renderPage();

		const input = await typeCode("12a-34 56");
		expect(input).toHaveValue("123456");
	});

	it("the backup link switches the field", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		renderPage();

		await fireEvent.click(
			screen.getByRole("button", { name: "Use a backup code instead" }),
		);

		expect(screen.getByText("Enter a backup code")).toBeInTheDocument();
		const input = screen.getByLabelText("Backup code");
		expect(input).not.toHaveAttribute("inputmode", "numeric");
		expect(
			screen.getByRole("button", {
				name: "Use your authenticator app instead",
			}),
		).toBeInTheDocument();
	});

	it("a wrong code shows the tries left", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		mockVerify.mockRejectedValue(
			new ApiError("That code didn't work.", {
				status: 401,
				errorKey: "login.twoStepWrongCode",
				details: { triesLeft: 4 },
			}),
		);
		renderPage();

		await typeCode("000000");

		expect(
			await screen.findByText("That code didn't work. 4 tries left."),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Code")).toBeInTheDocument();
	});

	it("a restart returns to the password step with the spec's message", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		mockVerify.mockRejectedValue(
			new ApiError("Too many tries. Sign in again.", {
				status: 401,
				errorKey: "login.twoStepTooManyTries",
			}),
		);
		renderPage();

		await typeCode("000000");

		expect(
			await screen.findByText("Too many tries. Sign in again."),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Email address")).toBeInTheDocument();
		expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
	});

	it("a backup code signs in and the next page is told how many are left", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		mockVerify.mockResolvedValue({
			ok: true,
			usedBackupCode: true,
			backupCodesLeft: 9,
		});
		renderPage();

		await fireEvent.click(
			screen.getByRole("button", { name: "Use a backup code instead" }),
		);
		await fireEvent.input(screen.getByLabelText("Backup code"), {
			target: { value: "7kq4m 2xwp0" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Verify" }));

		await waitFor(() =>
			expect(mockVerify).toHaveBeenCalledWith({ backupCode: "7kq4m 2xwp0" }),
		);
		await waitFor(() =>
			expect(mockGoto).toHaveBeenCalledWith("/?twoStepBackupLeft=9", {
				invalidateAll: true,
			}),
		);
		expect(mockInvalidateAll).toHaveBeenCalled();
	});

	it("Back to sign in returns to the password step", async () => {
		mockPage.url = new URL("http://localhost/login?step=two-step");
		renderPage();

		await fireEvent.click(
			screen.getByRole("button", { name: /Back to sign in/ }),
		);

		expect(screen.getByLabelText("Email address")).toBeInTheDocument();
	});

	it("a plain sign-in still goes straight home", async () => {
		renderPage();

		await submitPassword();

		await waitFor(() =>
			expect(mockGoto).toHaveBeenCalledWith("/", {
				invalidateAll: true,
			}),
		);
		expect(mockVerify).not.toHaveBeenCalled();
	});
});
