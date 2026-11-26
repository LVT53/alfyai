import type { ConnectionPublic } from "../store";
import type { ContactMatch } from "./contacts";
import { microsoftGraphRequest } from "./microsoft-graph";
import { onedriveGetAccessTokenForRead } from "./onedrive";

type OutlookContact = {
	displayName?: string;
	emailAddresses?: { address?: string }[];
	businessPhones?: string[];
	homePhones?: string[];
	mobilePhone?: string;
	companyName?: string;
	jobTitle?: string;
};

export async function outlookSearchContacts(
	conn: ConnectionPublic,
	params: { query: string; limit?: number },
	opts?: { fetch?: typeof fetch },
): Promise<ContactMatch[]> {
	const query = params.query.trim();
	if (!query) return [];
	const token = await onedriveGetAccessTokenForRead(conn, opts, "contacts");
	const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
	const literal = `'${query.replaceAll("'", "''")}'`;
	const filter = query.includes("@")
		? `emailAddresses/any(a:a/address eq ${literal})`
		: ["displayName", "givenName", "surname"]
				.map((field) => `startswith(${field},${literal})`)
				.join(" or ");
	const search = new URLSearchParams({
		$filter: filter,
		$top: String(limit),
		$select:
			"displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName,jobTitle",
	});
	let path = `/me/contacts?${search}`;
	const results: ContactMatch[] = [];
	for (let page = 0; page < 5; page++) {
		const response = await microsoftGraphRequest(token, "GET", path, opts);
		if (!response.ok) throw new Error("Outlook contacts lookup failed");
		const body = (await response.json()) as {
			value: OutlookContact[];
			"@odata.nextLink"?: string;
		};
		for (const row of body.value) {
			const emails = (row.emailAddresses ?? []).flatMap((entry) =>
				entry.address ? [entry.address] : [],
			);
			results.push({
				source: "onedrive",
				account: conn.accountIdentifier,
				name: row.displayName || emails[0] || "",
				emails,
				phones: [
					...new Set([
						...(row.businessPhones ?? []),
						...(row.homePhones ?? []),
						...(row.mobilePhone ? [row.mobilePhone] : []),
					]),
				],
				...(row.companyName || row.jobTitle
					? { organization: { company: row.companyName, title: row.jobTitle } }
					: {}),
			});
			if (results.length >= limit) return results;
		}
		if (!body["@odata.nextLink"]) break;
		const next = new URL(body["@odata.nextLink"]);
		if (
			next.origin !== "https://graph.microsoft.com" ||
			next.username ||
			next.password ||
			next.hash ||
			next.pathname !== "/v1.0/me/contacts"
		)
			throw new Error("Invalid Outlook contacts continuation");
		path = `/me/contacts${next.search}`;
	}
	return results;
}
