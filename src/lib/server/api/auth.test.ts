import { describe, expect, it } from "vitest";
import { requireApiUser } from "./auth";

// biome-ignore lint/suspicious/noExplicitAny: minimal event stub
const makeEvent = (user: unknown): any => ({ locals: { user } });

describe("requireApiUser", () => {
	it("returns the authenticated user when present", () => {
		const user = { id: "user-1", role: "user" };
		expect(requireApiUser(makeEvent(user))).toBe(user);
	});

	it("throws a 401 (not a 302 redirect) for an anonymous caller", () => {
		let thrown: unknown;
		try {
			requireApiUser(makeEvent(null));
		} catch (err) {
			thrown = err;
		}
		// SvelteKit's error() throws an HttpError with a numeric status and a
		// JSON-serializable body — never a Redirect (302).
		expect(thrown).toMatchObject({ status: 401 });
		expect((thrown as { status: number }).status).not.toBe(302);
		expect((thrown as { body: { message: string } }).body.message).toBe(
			"Unauthorized",
		);
	});
});
