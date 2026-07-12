#!/usr/bin/env tsx
//
// READ-ONLY diagnostic for live Connections. Exercises each connected account
// the same way the chat tools do, but captures the FULL HTTP status + error
// body that the production error-mapping deliberately discards — so we can see
// *why* calendar/contacts/files calls fail in real use.
//
// Safe to run on prod: performs only reads (list events, search contacts,
// PROPFIND folders). Never writes, never prints secrets (only presence).
//
// Run:  npx tsx scripts/diagnose-connections.ts [emailOrUserId] [nextcloudFolder] [contactQuery]
//   e.g. npx tsx scripts/diagnose-connections.ts levente@... /Documents "levente"

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

if (!process.env.SESSION_SECRET) {
	process.env.SESSION_SECRET = "mock-session-secret-for-dev-testing-only";
}
if (!process.env.DATABASE_PATH) {
	process.env.DATABASE_PATH = "./data/chat.db";
}

import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { hasLocalDistillEnabled } from "$lib/server/services/connections/locality";
import { googleSearchContacts } from "$lib/server/services/connections/providers/contacts";
import { googleRefreshAccessToken } from "$lib/server/services/connections/providers/google";
import { googleListEvents } from "$lib/server/services/connections/providers/google-calendar";
import {
	nextcloudListFolder,
	nextcloudSearch,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	getConnection,
	getConnectionSecret,
	listConnectionsForUser,
} from "$lib/server/services/connections/store";
import { runCalendarTool } from "$lib/server/services/normal-chat-tools/calendar";
import { runContactsTool } from "$lib/server/services/normal-chat-tools/contacts";
import { runFilesTool } from "$lib/server/services/normal-chat-tools/files";

const [, , filterArg, folderArg, contactQueryArg] = process.argv;
const folder = folderArg ?? "/";
const contactQuery = contactQueryArg ?? "a";

function line(s = "") {
	process.stdout.write(`${s}\n`);
}

async function bodyPreview(res: Response): Promise<string> {
	const text = await res.text().catch(() => "<no body>");
	return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

async function main() {
	const allUsers = await db.select().from(users);
	const targetUsers = filterArg
		? allUsers.filter((u) => u.id === filterArg || u.email === filterArg)
		: allUsers;

	if (targetUsers.length === 0) {
		line(`No user matched "${filterArg}". Known users:`);
		for (const u of allUsers) line(`  - ${u.email} (${u.id})`);
		return;
	}

	for (const user of targetUsers) {
		const conns = await listConnectionsForUser(user.id);
		if (conns.length === 0) continue;
		line("");
		line(`================ USER ${user.email} (${user.id}) ================`);
		line(`  localDistill(OptionA): ${await hasLocalDistillEnabled(user.id)}`);
		for (const c of conns) {
			line("");
			line(`--- connection: ${c.provider} / ${c.label} [${c.id}] ---`);
			line(`  account:      ${c.accountIdentifier}`);
			line(
				`  status:       ${c.status}${c.statusDetail ? ` (${c.statusDetail})` : ""}`,
			);
			line(`  capabilities: ${JSON.stringify(c.capabilities)}`);
			line(`  oauthScopes:  ${JSON.stringify(c.oauthScopes)}`);
			line(`  allowWrites:  ${c.allowWrites}   defaultOn: ${c.defaultOn}`);
			line(
				`  hasSecret:    ${c.hasSecret}   hasWriteSecret: ${c.hasWriteSecret}`,
			);
			line(
				`  tokenExpires: ${c.tokenExpiresAt ? new Date(c.tokenExpiresAt * 1000).toISOString() : "null"}`,
			);
			line(`  config keys:  ${JSON.stringify(Object.keys(c.config))}`);

			if (c.provider === "google") {
				await diagnoseGoogle(user.id, c.id);
			} else if (c.provider === "nextcloud") {
				await diagnoseNextcloud(user.id, c.id);
			}
		}

		await diagnoseToolLayer(user.id);
	}
}

// Reproduces EXACTLY what the chat model receives from each tool's execute()
// path (resolve connections -> provider call -> Option-A gate -> payload).
const MODEL_ID = "diagnostic-cloud-model";

async function reportTool(
	label: string,
	run: () => Promise<{ modelPayload: { success: boolean; message: string } }>,
) {
	line(`  >> TOOL ${label}`);
	try {
		const { modelPayload } = await run();
		line(
			`     success=${modelPayload.success}  message="${modelPayload.message}"`,
		);
	} catch (err) {
		line(
			`     execute THREW: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
		);
	}
}

async function diagnoseToolLayer(userId: string) {
	line("");
	line("  ======== TOOL LAYER (what the model actually sees) ========");
	// Calendar: default range (valid ISO, the happy path)
	await reportTool("calendar list_events (no dates, default 7d)", () =>
		runCalendarTool(userId, { action: "list_events" }, MODEL_ID),
	);
	// Calendar: DATE-ONLY range — the natural thing a model emits for
	// "next two weeks"; Google Calendar requires RFC3339 date-TIMEs.
	const today = new Date();
	const dOnly = (d: Date) => d.toISOString().slice(0, 10);
	await reportTool(
		`calendar list_events (DATE-ONLY start/end: ${dOnly(today)}..)`,
		() =>
			runCalendarTool(
				userId,
				{
					action: "list_events",
					start: dOnly(today),
					end: dOnly(new Date(today.getTime() + 14 * 864e5)),
				},
				MODEL_ID,
			),
	);
	// Contacts
	await reportTool(`contacts lookup query="${contactQuery}"`, () =>
		runContactsTool(
			userId,
			{ action: "lookup", query: contactQuery },
			MODEL_ID,
		),
	);
	// Files search + the NEW list action + a read-on-folder (should now refuse)
	await reportTool(
		`files search query="${folder.replace(/^\//, "") || "doc"}"`,
		() =>
			runFilesTool(
				userId,
				{ action: "search", query: folder.replace(/^\//, "") || "doc" },
				MODEL_ID,
			),
	);
	await reportTool(`files list path="${folder}" (NEW list action)`, () =>
		runFilesTool(
			userId,
			{ action: "list", path: folder === "/" ? undefined : folder },
			MODEL_ID,
		),
	);
	await reportTool(
		`files read path="${folder}" (folder path -> should now refuse)`,
		() => runFilesTool(userId, { action: "read", path: folder }, MODEL_ID),
	);

	line("");
	line("  ======== B-TIER live probes (connected connectors) ========");
	// Files: mtime now surfaced on list results.
	line("  >> B-tier files list — mtime surfaced?");
	try {
		const r = await runFilesTool(
			userId,
			{ action: "list", path: folder === "/" ? undefined : folder },
			MODEL_ID,
		);
		const first = r.modelPayload.results[0] as
			| { name?: string; mtime?: string | null }
			| undefined;
		line(
			`     success=${r.modelPayload.success}  first="${first?.name ?? "-"}" mtime=${first && "mtime" in first ? JSON.stringify(first.mtime) : "MISSING"}`,
		);
	} catch (err) {
		line(`     THREW: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Contacts: organization surfaced on lookup?
	line(
		`  >> B-tier contacts lookup "${contactQuery}" — organization surfaced?`,
	);
	try {
		const r = await runContactsTool(
			userId,
			{ action: "lookup", query: contactQuery },
			MODEL_ID,
		);
		const c = r.modelPayload.contacts[0] as
			| { name?: string; organization?: unknown }
			| undefined;
		line(
			`     success=${r.modelPayload.success}  count=${r.modelPayload.contacts.length}  first="${c?.name ?? "-"}" org=${c?.organization ? JSON.stringify(c.organization) : "none"}`,
		);
	} catch (err) {
		line(`     THREW: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Contacts: group action (Google contact groups).
	await reportTool('B-tier contacts group "Family"', () =>
		runContactsTool(userId, { action: "group", query: "Family" }, MODEL_ID),
	);
	// Calendar: list_calendars discovery.
	await reportTool("B-tier calendar list_calendars", () =>
		runCalendarTool(userId, { action: "list_calendars" }, MODEL_ID),
	);
}

async function diagnoseGoogle(userId: string, connectionId: string) {
	line("");
	line("  >> GOOGLE token refresh...");
	let token: string;
	try {
		token = await googleRefreshAccessToken(userId, connectionId);
		line(`     refresh OK (token len ${token.length})`);
	} catch (err) {
		line(
			`     refresh FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
		);
		return;
	}

	// --- Calendar: raw fetch, full body on error ---
	const now = new Date();
	const timeMin = now.toISOString();
	const timeMax = new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString();
	const calUrl = new URL(
		"https://www.googleapis.com/calendar/v3/calendars/primary/events",
	);
	calUrl.searchParams.set("singleEvents", "true");
	calUrl.searchParams.set("orderBy", "startTime");
	calUrl.searchParams.set("timeMin", timeMin);
	calUrl.searchParams.set("timeMax", timeMax);
	calUrl.searchParams.set("maxResults", "5");
	line("  >> CALENDAR raw GET /calendars/primary/events (next 14d)...");
	try {
		const res = await fetch(calUrl.toString(), {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.ok) {
			const body = (await res.json()) as { items?: unknown[] };
			line(`     HTTP ${res.status} OK — ${body.items?.length ?? 0} event(s)`);
		} else {
			line(`     HTTP ${res.status} FAIL — body:`);
			line(`     ${await bodyPreview(res)}`);
		}
	} catch (err) {
		line(`     THREW: ${err instanceof Error ? err.message : String(err)}`);
	}

	// --- Calendar via the real provider fn ---
	line("  >> CALENDAR via googleListEvents()...");
	try {
		const events = await googleListEvents(userId, connectionId, {
			timeMin,
			timeMax,
			maxResults: 5,
		});
		line(`     provider returned ${events.length} event(s)`);
	} catch (err) {
		line(
			`     provider THREW: ${err instanceof Error ? `${err.name}[${(err as { code?: string }).code}]: ${err.message}` : String(err)}`,
		);
	}

	// --- People: warmup + search, raw fetch, full body on error ---
	for (const q of ["", contactQuery]) {
		const label = q === "" ? "warmup (empty query)" : `query="${q}"`;
		const peopleUrl = new URL(
			"https://people.googleapis.com/v1/people:searchContacts",
		);
		peopleUrl.searchParams.set("query", q);
		peopleUrl.searchParams.set("readMask", "names,emailAddresses,phoneNumbers");
		peopleUrl.searchParams.set("pageSize", "5");
		line(`  >> CONTACTS raw GET people:searchContacts ${label}...`);
		try {
			const res = await fetch(peopleUrl.toString(), {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.ok) {
				const body = (await res.json()) as { results?: unknown[] };
				line(
					`     HTTP ${res.status} OK — ${body.results?.length ?? 0} result(s)`,
				);
			} else {
				line(`     HTTP ${res.status} FAIL — body:`);
				line(`     ${await bodyPreview(res)}`);
			}
		} catch (err) {
			line(`     THREW: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// --- Contacts via the real provider fn ---
	line("  >> CONTACTS via googleSearchContacts()...");
	try {
		const matches = await googleSearchContacts(userId, connectionId, {
			query: contactQuery,
			limit: 5,
		});
		line(`     provider returned ${matches.length} match(es)`);
	} catch (err) {
		line(
			`     provider THREW: ${err instanceof Error ? `${err.name}[${(err as { code?: string }).code}]: ${err.message}` : String(err)}`,
		);
	}
}

async function diagnoseNextcloud(userId: string, connectionId: string) {
	const conn = await getConnection(userId, connectionId);
	const secret = await getConnectionSecret(userId, connectionId);
	if (!conn || !secret) {
		line("  >> NEXTCLOUD: missing connection or secret");
		return;
	}
	for (const p of ["/", folder]) {
		line(`  >> NEXTCLOUD nextcloudListFolder("${p}")...`);
		try {
			const files = await nextcloudListFolder(conn, secret, p);
			const dirs = files.filter((f) => f.isDir).length;
			line(
				`     ${files.length} child(ren): ${dirs} folder(s), ${files.length - dirs} file(s)`,
			);
			for (const f of files.slice(0, 8)) {
				line(`       ${f.isDir ? "[dir] " : "      "}${f.name}`);
			}
		} catch (err) {
			line(
				`     THREW: ${err instanceof Error ? `${err.name}[${(err as { code?: string }).code}]: ${err.message}` : String(err)}`,
			);
		}
	}
	line(
		`  >> NEXTCLOUD nextcloudSearch("${folder.replace(/^\//, "") || "doc"}")...`,
	);
	try {
		const q = folder.replace(/^\//, "").split("/").pop() || "doc";
		const found = await nextcloudSearch(conn, secret, q);
		line(`     search "${q}" -> ${found.length} hit(s)`);
	} catch (err) {
		line(`     THREW: ${err instanceof Error ? err.message : String(err)}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		line(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
		process.exit(1);
	});
