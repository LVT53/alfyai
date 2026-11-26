import { describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { outlookSearchContacts } from "./outlook-contacts";

const token = vi.hoisted(() => vi.fn().mockResolvedValue("access"));
vi.mock("./onedrive", () => ({ onedriveGetAccessTokenForRead: token }));
const conn = {
	id: "m",
	accountIdentifier: "work@example.com",
} as ConnectionPublic;
describe("Outlook contacts", () => {
	it("escapes names, limits fields and checks only the selected account's contact grant", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				value: [
					{
						displayName: "O'Neil",
						businessPhones: ["123"],
						companyName: "Acme",
						emailAddresses: [{ address: "one@example.com" }],
					},
				],
			}),
		);
		const result = await outlookSearchContacts(
			conn,
			{ query: "O'Neil", limit: 1 },
			{ fetch },
		);
		const url = new URL(fetch.mock.calls[0][0]);
		expect(url.pathname).toBe("/v1.0/me/contacts");
		expect(url.searchParams.get("$filter")).toContain(
			"startswith(surname,'O''Neil')",
		);
		expect(url.searchParams.get("$select")).not.toContain("personalNotes");
		expect(token).toHaveBeenCalledWith(conn, { fetch }, "contacts");
		expect(result[0]).toMatchObject({
			name: "O'Neil",
			source: "onedrive",
			account: conn.accountIdentifier,
			emails: ["one@example.com"],
			phones: ["123"],
			organization: { company: "Acme" },
		});
	});
	it("uses Graph's exact email filter and refuses a continuation for a different account", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				value: [],
				"@odata.nextLink":
					"https://graph.microsoft.com/v1.0/users/other/contacts",
			}),
		);
		await expect(
			outlookSearchContacts(conn, { query: "some@example.com" }, { fetch }),
		).rejects.toThrow();
		expect(new URL(fetch.mock.calls[0][0]).searchParams.get("$filter")).toBe(
			"emailAddresses/any(a:a/address eq 'some@example.com')",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
