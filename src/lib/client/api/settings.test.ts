import { describe, expect, it, vi } from "vitest";
import { fetchUserSettings } from "./settings";

describe("settings client API", () => {
	it("loads user settings including the resolved system default model", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "user-1",
					email: "user@example.com",
					name: "User",
					role: "admin",
					preferences: {
						preferredModel: null,
						effectiveModel: "provider:fire-pass",
						systemDefaultModel: "provider:fire-pass",
						theme: "system",
						titleLanguage: "auto",
						uiLanguage: "en",
						avatarId: null,
						preferredPersonalityId: null,
					},
					profilePicture: null,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(fetchUserSettings(fetchImpl)).resolves.toMatchObject({
			preferences: {
				preferredModel: null,
				effectiveModel: "provider:fire-pass",
				systemDefaultModel: "provider:fire-pass",
			},
		});
		expect(fetchImpl).toHaveBeenCalledWith("/api/settings");
	});
});
