import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("a paired rider can sync from outside their browser and revoke the bridge", async ({
	page,
	playwright,
}) => {
	await login(page);
	const endpoint = new URL("/api/connections/bosch", page.url()).href;
	const bridge = await playwright.request.newContext();
	let connectionId: string | undefined;
	try {
		expect((await bridge.post(`${endpoint}/start`)).status()).toBe(401);
		const result = await page.request.post(`${endpoint}/start`);
		expect(result.ok()).toBeTruthy();
		const pairing = await result.json();
		connectionId = pairing.connectionId;
		const send = () =>
			bridge.post(`${endpoint}/sync`, {
				headers: { Authorization: `Bearer ${pairing.pairingToken}` },
				data: {
					bikes: [{ id: "synthetic-bike", name: "Test bike" }],
					rides: [],
					complete: true,
				},
			});
		expect((await send()).status()).toBe(204);
		const removal = new URL(`/api/connections/${connectionId}`, page.url())
			.href;
		expect((await page.request.delete(removal)).ok()).toBeTruthy();
		connectionId = undefined;
		expect((await send()).status()).toBe(401);
	} finally {
		if (connectionId)
			await page.request.delete(
				new URL(`/api/connections/${connectionId}`, page.url()).href,
			);
		await bridge.dispose();
	}
});
