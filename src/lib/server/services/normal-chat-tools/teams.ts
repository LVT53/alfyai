import { microsoftCanWrite } from "$lib/shared/microsoft-permissions";
import type { ConnectorReasonCode } from "$lib/shared/tool-reasons";
import { createPendingWrite } from "../connections/pending-writes";
import {
	type TeamsInput,
	TeamsReadError,
	teamsDestination,
	teamsRead,
	teamsRoute,
	teamsToolInputSchema,
} from "../connections/providers/teams-messaging";
import {
	matchingConnections,
	resolveConnectionsForCapability,
} from "../connections/resolve";
import {
	buildWritePreview,
	idempotencyKey,
	type WriteOperation,
} from "../connections/write-guard";
import type { ToolEvidenceCandidate } from "../message-evidence";
import { applyLocalDistillGate } from "./connector-distill";
import { withReasonCode } from "./shared";

export { teamsToolInputSchema };
export function sanitizeTeamsToolInput(input: TeamsInput) {
	return teamsToolInputSchema.parse(input);
}
type Items = Awaited<ReturnType<typeof teamsRead>>["items"];
type Payload = {
	success: boolean;
	name: "teams";
	sourceType: "tool";
	action: TeamsInput["action"];
	message: string;
	items: Items;
	more: boolean;
	citations: { label: string; url: string }[];
	pendingWriteId?: string;
};
type Outcome = { modelPayload: Payload; candidates: ToolEvidenceCandidate[] };
export async function runTeamsTool(
	userId: string,
	input: TeamsInput,
	modelId: string,
	activeCapabilities: ReadonlySet<string>,
	conversationId?: string | null,
): Promise<Outcome> {
	const base: Payload = {
		success: false,
		name: "teams",
		sourceType: "tool",
		action: input.action,
		message: "",
		items: [],
		more: false,
		citations: [],
	};
	const fail = (reason: ConnectorReasonCode, message: string): Outcome => ({
		modelPayload: withReasonCode({ ...base, message }, reason),
		candidates: [],
	});
	let route: ReturnType<typeof teamsRoute>;
	try {
		route = teamsRoute(sanitizeTeamsToolInput(input));
	} catch {
		return fail(
			"not_supported",
			"Specify the exact Teams destination and required action fields.",
		);
	}
	const relevant = route.directory
		? (["teams_channels", "teams_files"] as const)
		: route.chat
			? (["teams_chat"] as const)
			: (["teams_channels"] as const);
	const caps = relevant.filter((c) => activeCapabilities.has(c));
	if (!caps.length)
		return fail(
			"not_connected",
			"This Teams capability is disabled for this conversation.",
		);
	try {
		const groups = await Promise.all(
			caps.map(async (capability) => ({
				capability,
				connections: await resolveConnectionsForCapability(userId, capability),
			})),
		);
		const all = [
			...new Map(
				groups.flatMap((g) => g.connections.map((c) => [c.id, c] as const)),
			).values(),
		];
		const matches = input.account
			? matchingConnections(all, input.account)
			: all;
		if (matches.length !== 1)
			return fail(
				all.length ? "no_such_account" : "not_connected",
				all.length
					? "Ask which Microsoft account to use."
					: "Connect a Microsoft work or school account for Teams.",
			);
		const conn = matches[0];
		const cap = groups.find((g) =>
			g.connections.some((c) => c.id === conn.id),
		)?.capability;
		if (!cap)
			return fail("not_connected", "This Teams capability is unavailable.");
		if (route.write) {
			if (cap === "teams_files" || !microsoftCanWrite(conn, cap))
				return fail(
					conn.allowWrites ? "read_only_account" : "writes_turned_off",
					"Enable Teams writes for this account.",
				);
			const target = await teamsDestination(conn, input);
			const content = JSON.stringify({ ...input, ...target });
			const op: WriteOperation = {
				provider: "onedrive",
				connectionId: conn.id,
				action: `teams.${input.action}`,
				summary: `Teams · ${target.destination}`,
				target: { id: route.path, label: target.destination },
				reversible: Boolean(input.reaction),
				destructive: false,
				payloadFingerprint: content,
			};
			const pending = await createPendingWrite(userId, {
				connectionId: conn.id,
				provider: "onedrive",
				op,
				content,
				idempotencyKey: idempotencyKey(op),
				preview: buildWritePreview(op),
				conversationId: conversationId ?? undefined,
			});
			return {
				modelPayload: {
					...base,
					success: true,
					message: "Ask the user to confirm the Teams change on the card.",
					pendingWriteId: pending.id,
				},
				candidates: [],
			};
		}
		const { items, more } = await teamsRead(conn, input, cap);
		const outcome: Outcome = {
			modelPayload: {
				...base,
				success: true,
				items,
				more,
				message: more
					? "Showing a limited set of Teams results."
					: "Teams lookup completed.",
				citations: items
					.filter((i) => i.url)
					.map((i) => ({ label: i.label, url: i.url })),
			},
			candidates: items.map((i) => ({
				id: `teams:${conn.id}:${route.path}:${i.id}`,
				title: i.label,
				url: i.url,
				snippet: i.body.slice(0, 480),
				sourceType: "tool",
			})),
		};
		const redact = (o: Outcome, message: string): Outcome => ({
			...o,
			modelPayload: { ...o.modelPayload, items: [], citations: [], message },
		});
		return await applyLocalDistillGate({
			userId,
			modelId,
			capability: cap,
			userQuestion: input.action,
			rawText: items.map((i) => JSON.stringify(i)).join("\n"),
			outcome,
			onDistilled: (o, summary) => redact(o, summary),
			onUnavailable: (o) =>
				redact(
					o,
					"Teams details were withheld because private summarization was unavailable.",
				),
		});
	} catch (e) {
		if (e instanceof TeamsReadError) {
			if (e.status === 401 || e.status === 403)
				return fail(
					"needs_reconnect",
					"The account could not access this Teams resource.",
				);
			if (e.status === 404)
				return fail(
					"item_not_found",
					"This Teams resource is no longer available.",
				);
		}
		return fail(
			"account_unreachable",
			"The Teams request could not be completed.",
		);
	}
}
