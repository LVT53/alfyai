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
					bikes: [
						{ id: "synthetic-bike", name: "Test bike" },
						{ id: "other-bike", name: null },
					],
					rides: [],
					complete: true,
				},
			});
		expect((await send()).status()).toBe(204);
		await page.goto("/settings?section=connections");
		const openDetails = page.getByTestId(`connection-details-${connectionId}`);
		await openDetails.click();
		const dialog = page.getByTestId(`connection-detail-${connectionId}`);
		await expect(
			dialog.getByText("Read your bikes, rides and cycling statistics."),
		).toBeVisible();
		const bikeForm = dialog.getByRole("form", { name: /synthetic-bike/ });
		const bike = bikeForm.getByRole("textbox");
		const other = dialog.getByRole("textbox", { name: /other-bike/ });
		await bike.fill("My Cube");
		await bikeForm.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog.getByText("Bike name saved.")).toBeVisible();
		expect(
			(await (await page.request.get(`${endpoint}/bikes`)).json()).bikes,
		).toContainEqual({ id: "synthetic-bike", name: "My Cube" });
		await page.reload();
		await openDetails.click();
		await expect(bike).toHaveValue("My Cube");
		await expect(other).toHaveValue("");
		await bike.fill("");
		await bikeForm.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog.getByText("Bike name saved.")).toBeVisible();
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
