import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchActiveCapabilities } from "./connections";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchActiveCapabilities", () => {
	it("requests the active-capabilities endpoint and returns served/defaultOn/accounts", async () => {
		const payload = {
			served: ["calendar", "files"],
			defaultOn: ["files"],
			accounts: [
				{
					capability: "calendar",
					connections: [
						{ id: "conn-work", label: "Work Google", provider: "google" },
						{
							id: "conn-personal",
							label: "Personal Google",
							provider: "google",
						},
					],
				},
				{
					capability: "files",
					connections: [
						{ id: "conn-nextcloud", label: "Nextcloud", provider: "nextcloud" },
					],
				},
			],
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchActiveCapabilities();

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/active-capabilities",
		);
		expect(result).toEqual(payload);
	});

	it("throws on a failed request", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "nope" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchActiveCapabilities()).rejects.toThrow();
	});
});
