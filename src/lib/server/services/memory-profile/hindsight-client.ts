import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { memoryBanks } from "$lib/server/db/schema";
import {
	HINDSIGHT_ENGINE_COMMIT,
	NATIVE_BANK_CONFIG,
	type NativeMemory,
	NativeMemoryError,
	type NativeOperation,
	type RetainSource,
} from "./contracts";
import { approvedMemoryBase, fetchPrivateMemory } from "./private-endpoint";

export { NativeMemoryError } from "./contracts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new NativeMemoryError("native_format_unsupported", false);
	return value as Record<string, unknown>;
}
function memories(value: unknown): NativeMemory[] {
	if (!Array.isArray(value))
		throw new NativeMemoryError("native_format_unsupported", false);
	return value.map((raw) => {
		const r = object(raw);
		if (
			typeof r.id !== "string" ||
			typeof r.text !== "string" ||
			typeof r.fact_type !== "string" ||
			(r.source_memory_ids !== undefined &&
				(!Array.isArray(r.source_memory_ids) ||
					r.source_memory_ids.some((x) => typeof x !== "string")))
		)
			throw new NativeMemoryError("native_format_unsupported", false);
		return r as unknown as NativeMemory;
	});
}
/** Server-only, bound to a single authorized bank. Never expose as an HTTP proxy. */
export class HindsightClient {
	private readonly base: string;
	private readonly url: string;
	private capabilityCheck?: Promise<void>;
	constructor(
		private readonly options: {
			baseUrl: string;
			allowedUrls?: readonly string[];
			apiKey: string;
			bankId: string;
			tenantId?: string;
			fetcher?: typeof fetch;
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	) {
		this.base = options.allowedUrls
			? approvedBase(options.baseUrl, options.allowedUrls)
			: options.baseUrl.replace(/\/+$/, "");
		const base = URL.parse(this.base);

		if (
			!base ||
			(!options.allowedUrls && !options.fetcher) ||
			!["http:", "https:"].includes(base.protocol) ||
			base.username ||
			base.password ||
			!options.apiKey ||
			!options.bankId
		)
			throw new NativeMemoryError("native_config_invalid", false);
		this.url = `${this.base}/v1/default/banks/${encodeURIComponent(options.bankId)}`;
	}
	private async send(
		url: string,
		init: RequestInit,
		beforeDispatch?: () => Promise<void>,
	): Promise<Response> {
		if (!this.options.allowedUrls && this.options.fetcher) {
			if (beforeDispatch) await beforeDispatch();
			init.signal?.throwIfAborted();
			return this.options.fetcher(url, init);
		}
		return fetchPrivateMemory(url, init, this.options.fetcher, beforeDispatch);
	}
	async verifyCapabilities(): Promise<void> {
		const response = await this.send(`${this.base}/ext/alfyai/capabilities`, {
			headers: { Authorization: `Bearer ${this.options.apiKey}` },
			redirect: "error",
			signal: AbortSignal.any([
				AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
				...(this.options.signal ? [this.options.signal] : []),
			]),
		});
		if (!response.ok)
			throw new NativeMemoryError(
				"native_capability_unavailable",
				response.status >= 500,
			);
		const value = object(await response.json());
		const expected = this.options.tenantId
			? createHash("sha256")
					.update(`alfyai_t_${this.options.tenantId.replaceAll("-", "_")}`)
					.digest("hex")
			: null;
		if (
			value.engine_commit !== HINDSIGHT_ENGINE_COMMIT ||
			value.extension !== "alfyai-identity-v1" ||
			!["StaticKeysTenantExtension", "AlfyTenant"].includes(
				String(value.tenant_extension),
			) ||
			!expected ||
			value.tenant_binding !== expected
		) {
			throw new NativeMemoryError("native_capability_mismatch", false);
		}
	}
	private async request(
		path: string,
		method = "GET",
		body?: unknown,
		beforeDispatch?: () => Promise<void>,
	): Promise<Record<string, unknown>> {
		try {
			if (this.options.tenantId) {
				this.capabilityCheck ??= this.verifyCapabilities();
				await this.capabilityCheck;
			}
			const signal = AbortSignal.any([
				AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
				...(this.options.signal ? [this.options.signal] : []),
			]);
			const response = await this.send(
				this.url + path,
				{
					method,
					redirect: "error",
					headers: {
						Authorization: `Bearer ${this.options.apiKey}`,
						"Content-Type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal,
				},
				beforeDispatch,
			);
			if (method === "DELETE" && response.status === 404) return {};
			if (!response.ok)
				throw new NativeMemoryError(
					response.status === 404
						? "native_not_found"
						: response.status === 401 || response.status === 403
							? "native_unauthorized"
							: "native_unavailable",
					response.status >= 500 || response.status === 429,
				);
			if (response.status === 204) return {};
			return object(await response.json());
		} catch (error) {
			if (error instanceof NativeMemoryError) throw error;
			throw new NativeMemoryError(
				this.options.signal?.aborted
					? "native_cancelled"
					: "native_unavailable",
				!this.options.signal?.aborted,
			);
		}
	}
	async configure(beforeDispatch: () => Promise<void>): Promise<void> {
		// The pinned PATCH validates, creates the bank if absent, and persists
		// its config. A separate PUT would add another ambiguous mutation.
		await this.request(
			"/config",
			"PATCH",
			{ updates: NATIVE_BANK_CONFIG },
			beforeDispatch,
		);
		await this.verifyConfig();
	}
	async verifyConfig(): Promise<void> {
		const config = await this.request("/config");
		const effective = object(config.config ?? config);
		for (const [key, value] of Object.entries(NATIVE_BANK_CONFIG)) {
			if (effective[key] !== value)
				throw new NativeMemoryError("native_config_mismatch", false);
		}
	}
	async retain(item: RetainSource, operationId: string): Promise<string[]> {
		const result = await this.request("/memories", "POST", {
			items: [item],
			async: true,
			operation_id: operationId,
		});
		const ids =
			result.operation_ids ??
			(typeof result.operation_id === "string" ? [result.operation_id] : []);
		if (
			!Array.isArray(ids) ||
			!ids.length ||
			ids.some((id) => typeof id !== "string") ||
			ids.length !== 1 ||
			ids[0] !== operationId
		)
			throw new NativeMemoryError("native_format_unsupported", false);
		return ids as string[];
	}
	async operation(id: string): Promise<NativeOperation> {
		const r = await this.request(`/operations/${encodeURIComponent(id)}`);
		if (typeof r.status !== "string")
			throw new NativeMemoryError("native_format_unsupported", false);
		return { id, status: r.status };
	}
	async consolidate(): Promise<string> {
		const r = await this.request("/consolidate", "POST", {});
		if (typeof r.operation_id !== "string")
			throw new NativeMemoryError("native_format_unsupported", false);
		return r.operation_id;
	}
	async pendingOperations(): Promise<NativeOperation[]> {
		const result: NativeOperation[] = [];
		for (const status of ["pending", "processing"]) {
			for (let offset = 0; offset < 10000; offset += 100) {
				const page = await this.request(
					`/operations?status=${status}&limit=100&offset=${offset}`,
				);
				if (!Array.isArray(page.operations))
					throw new NativeMemoryError("native_format_unsupported", false);
				for (const value of page.operations) {
					const op = object(value);
					if (typeof op.id !== "string" || typeof op.status !== "string")
						throw new NativeMemoryError("native_format_unsupported", false);
					result.push({ id: op.id, status: op.status });
				}
				if (page.operations.length < 100) break;
				if (offset === 9900)
					throw new NativeMemoryError("native_backlog_limit", true);
			}
		}
		return result;
	}
	async list(): Promise<NativeMemory[]> {
		const result: NativeMemory[] = [];
		const seen = new Set<string>();
		let total: number | undefined;
		for (let offset = 0; offset < 100000; offset += 100) {
			const page = await this.request(
				`/memories/list?state=valid&limit=100&offset=${offset}`,
			);
			if (
				typeof page.total !== "number" ||
				!Number.isInteger(page.total) ||
				page.total < 0 ||
				page.offset !== offset ||
				(total !== undefined && page.total !== total)
			)
				throw new NativeMemoryError("native_capture_unstable", true);
			total = page.total;
			const rows = memories(page.items);
			if (rows.length > 100 || rows.some((row) => seen.has(row.id)))
				throw new NativeMemoryError("native_capture_unstable", true);
			for (const row of rows) {
				if (seen.has(row.id))
					throw new NativeMemoryError("native_capture_unstable", true);
				seen.add(row.id);
				result.push(row);
			}
			if (result.length === total) return result;
			if (rows.length !== 100 || result.length > total)
				throw new NativeMemoryError("native_capture_unstable", true);
		}
		throw new NativeMemoryError("native_capture_too_large", false);
	}
	async recall(query: string, maxTokens: number): Promise<NativeMemory[]> {
		const r = await this.request("/memories/recall", "POST", {
			query,
			types: ["observation"],
			budget: "mid",
			max_tokens: maxTokens,
			include: {
				entities: null,
				chunks: null,
				source_facts: { max_tokens: 0, max_tokens_per_observation: 0 },
			},
		});
		if (!Array.isArray(r.results))
			throw new NativeMemoryError("native_format_unsupported", false);
		return r.results.map((value) => {
			const item = object(value);
			if (
				typeof item.id !== "string" ||
				typeof item.text !== "string" ||
				item.type !== "observation"
			)
				throw new NativeMemoryError("native_format_unsupported", false);
			const ids = item.source_fact_ids;
			return {
				id: item.id,
				text: item.text,
				fact_type: "observation",
				...(Array.isArray(ids) && ids.every((id) => typeof id === "string")
					? { source_memory_ids: ids }
					: {}),
			};
		});
	}
	async editFact(
		id: string,
		patch: {
			text?: string;
			state?: "valid" | "invalidated";
			mentioned_at?: string;
			reason?: string;
		},
	): Promise<void> {
		await this.request(`/memories/${encodeURIComponent(id)}`, "PATCH", patch);
	}
	async deleteDocument(id: string): Promise<void> {
		await this.request(`/documents/${encodeURIComponent(id)}`, "DELETE");
	}
	async bankExists(): Promise<boolean> {
		try {
			await this.request("/config");
			return true;
		} catch (error) {
			if (
				error instanceof NativeMemoryError &&
				error.code === "native_not_found"
			)
				return false;
			throw error;
		}
	}
	async deleteBank(): Promise<void> {
		await this.request("", "DELETE");
	}
}

export interface NativeBinding {
	baseUrl: string;
	credentialHash: string;
}
function tenantKey(tenantId: string, expectedHash?: string): string {
	const config = getConfig();
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			tenantId,
		)
	)
		throw new NativeMemoryError("native_tenant_invalid", false);
	let masters: Record<string, unknown>;
	try {
		masters = object(JSON.parse(config.hindsightTenantMasterKeys));
	} catch {
		throw new NativeMemoryError("native_config_invalid", false);
	}
	if (Object.keys(masters).length) {
		const versions = expectedHash
			? Object.keys(masters)
			: [config.hindsightTenantActiveKey];
		for (const version of versions) {
			const master = masters[version];
			if (
				!/^[A-Za-z0-9_-]{1,24}$/.test(version) ||
				typeof master !== "string" ||
				!/^[0-9a-f]{64}$/.test(master)
			)
				throw new NativeMemoryError("native_config_invalid", false);
			const body = `${version}.${tenantId}`;
			const key = `${body}.${createHmac("sha256", Buffer.from(master, "hex")).update(body).digest("hex")}`;
			if (
				!expectedHash ||
				createHash("sha256").update(key).digest("hex") === expectedHash
			)
				return key;
		}
		throw new NativeMemoryError("native_binding_credentials_changed", false);
	}
	let keys: unknown;
	try {
		keys = JSON.parse(config.hindsightTenantKeys);
	} catch {
		throw new NativeMemoryError("native_config_invalid", false);
	}
	if (!keys || typeof keys !== "object" || !(tenantId in keys))
		throw new NativeMemoryError("native_tenant_unconfigured", false);
	const key = (keys as Record<string, unknown>)[tenantId];
	if (typeof key !== "string" || !key)
		throw new NativeMemoryError("native_tenant_unconfigured", false);
	return key;
}
function approvedBase(url: string, allowed: readonly string[]): string {
	try {
		return approvedMemoryBase(url, allowed);
	} catch {
		throw new NativeMemoryError("native_destination_invalid", false);
	}
}
export function configuredNativeBinding(tenantId: string): NativeBinding {
	const config = getConfig();
	return {
		baseUrl: approvedBase(config.hindsightUrl, config.hindsightAllowedUrls),
		credentialHash: createHash("sha256")
			.update(tenantKey(tenantId))
			.digest("hex"),
	};
}
export function nativeMemoryClient(
	bankId: string,
	tenantId: string,
	signal?: AbortSignal,
	binding?: NativeBinding,
): HindsightClient {
	const bank = binding
		? null
		: db.select().from(memoryBanks).where(eq(memoryBanks.id, bankId)).get();
	const effective =
		binding ??
		(bank?.nativeBaseUrl && bank.nativeCredentialHash
			? {
					baseUrl: bank.nativeBaseUrl,
					credentialHash: bank.nativeCredentialHash,
				}
			: configuredNativeBinding(tenantId));
	const key = tenantKey(tenantId, effective.credentialHash);
	if (
		createHash("sha256").update(key).digest("hex") !== effective.credentialHash
	)
		throw new NativeMemoryError("native_binding_credentials_changed", false);
	return new HindsightClient({
		baseUrl: effective.baseUrl,
		allowedUrls: getConfig().hindsightAllowedUrls,
		apiKey: key,
		bankId,
		tenantId,
		signal,
	});
}
