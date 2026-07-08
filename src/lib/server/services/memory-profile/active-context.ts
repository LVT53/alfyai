import { and, desc, eq, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryProfileItems } from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	createIdentityTextSanitizer,
	getMemoryProfileIdentity,
	sanitizePublicMemoryText,
} from "./identity-sanitizer";
import {
	ensureProjectionState,
	expireOverdueActiveMemoryProfileItems,
	listProjectionPolicyBlockedStatements,
} from "./projection-store";
import { getCurrentMemoryResetGeneration } from "./reset-generation";
import { fromScopeColumns, toScopeColumns } from "./scope";
import {
	type ActiveMemoryProfileContext,
	assertMemoryProfileCategory,
	type FormattedActiveMemoryProfileContext,
	type MemoryProfileScope,
} from "./types";

function formatActiveMemoryProfileItem(
	item: ActiveMemoryProfileContext["items"][number],
): string {
	const scope =
		item.scope.type === "global"
			? "global"
			: `${item.scope.type}:${item.scope.id}`;
	return `- ${item.category} (${scope}): ${item.statement}`;
}

function omittedActiveMemoryProfileLine(count: number): string {
	return `Omitted active memory profile items: ${count}.`;
}

function sortActiveMemoryProfileItemsNewestFirst(
	items: ActiveMemoryProfileContext["items"],
): ActiveMemoryProfileContext["items"] {
	return [...items].sort((left, right) => {
		const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
		if (updatedDelta !== 0) return updatedDelta;
		return right.id.localeCompare(left.id);
	});
}

export function formatActiveMemoryProfileContextForPrompt(
	context: ActiveMemoryProfileContext,
	options: { maxTokens: number },
): FormattedActiveMemoryProfileContext {
	const maxTokens = Math.max(0, Math.floor(options.maxTokens));
	const orderedItems = sortActiveMemoryProfileItemsNewestFirst(context.items);
	const lines: string[] = [];
	const includedItemIds: string[] = [];
	let omittedCount = 0;

	for (const item of orderedItems) {
		const line = formatActiveMemoryProfileItem(item);
		const candidateLines = [...lines, line];
		const remainingIfIncluded =
			orderedItems.length - includedItemIds.length - 1;
		let candidateFits =
			estimateTokenCount(candidateLines.join("\n")) <= maxTokens;
		if (candidateFits && remainingIfIncluded > 0) {
			const omittedLine = omittedActiveMemoryProfileLine(remainingIfIncluded);
			const fullCandidate = [...candidateLines, omittedLine].join("\n");
			const compactCandidate = [
				...candidateLines,
				`Omitted: ${remainingIfIncluded}.`,
			].join("\n");
			candidateFits =
				estimateTokenCount(fullCandidate) <= maxTokens ||
				estimateTokenCount(compactCandidate) <= maxTokens;
		}
		if (!candidateFits) {
			omittedCount += 1;
			continue;
		}
		lines.push(line);
		includedItemIds.push(item.id);
	}

	if (omittedCount > 0) {
		const omittedLine = omittedActiveMemoryProfileLine(omittedCount);
		const compactOmittedLine = `Omitted: ${omittedCount}.`;
		if (estimateTokenCount([...lines, omittedLine].join("\n")) <= maxTokens) {
			lines.push(omittedLine);
		} else if (
			estimateTokenCount([...lines, compactOmittedLine].join("\n")) <= maxTokens
		) {
			lines.push(compactOmittedLine);
		} else if (lines.length === 0) {
			lines.push(
				estimateTokenCount(omittedLine) <= maxTokens
					? omittedLine
					: compactOmittedLine,
			);
		}
	}

	const content = lines.join("\n");
	return {
		content,
		includedCount: includedItemIds.length,
		omittedCount,
		estimatedTokens: estimateTokenCount(content),
		includedItemIds,
	};
}

export async function getActiveMemoryProfileContext(params: {
	userId: string;
	applicableScopes?: MemoryProfileScope[];
}): Promise<ActiveMemoryProfileContext> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const identity = await getMemoryProfileIdentity(params.userId);
	const sanitizer = createIdentityTextSanitizer({
		userId: params.userId,
		displayName: identity.displayName,
	});
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const expiredCount = await expireOverdueActiveMemoryProfileItems({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
	});
	const scopeConditions = [
		eq(memoryProfileItems.scopeType, "global"),
		...(params.applicableScopes ?? [])
			.filter((scope) => scope.type !== "global")
			.map((scope) => {
				const columns = toScopeColumns(scope);
				return and(
					eq(memoryProfileItems.scopeType, columns.scopeType),
					eq(memoryProfileItems.scopeId, columns.scopeId),
				);
			}),
	];
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
				or(...scopeConditions),
			),
		)
		.orderBy(desc(memoryProfileItems.updatedAt));

	return {
		resetGeneration,
		projectionRevision: projection.revision + expiredCount,
		items: rows.map((row) => {
			assertMemoryProfileCategory(row.category);
			return {
				id: row.id,
				itemKey: row.itemKey,
				category: row.category,
				statement: sanitizePublicMemoryText(row.statement, sanitizer),
				scope: fromScopeColumns(row.scopeType, row.scopeId),
				revision: row.revision,
				updatedAt: row.updatedAt,
			};
		}),
	};
}

export type {
	ActiveMemoryProfileContext,
	FormattedActiveMemoryProfileContext,
	MemoryProfilePolicyBlockedStatement,
	MemoryProfileScope,
} from "./types";
export { listProjectionPolicyBlockedStatements };
