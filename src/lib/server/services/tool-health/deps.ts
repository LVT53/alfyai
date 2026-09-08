// Production dependencies for the tool health runner. Kept in its own module
// (loaded lazily by index.ts) so unit tests that inject fake deps never touch
// dockerode, the database, or config-store.

import { eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { routingRegions, userConnections } from "$lib/server/db/schema";
import {
	CAPABILITIES,
	type Capability,
} from "$lib/server/services/connections/registry";
import { TOOL_HEALTH_REGISTRY } from "./registry";
import {
	type ConnectedConnectionCounts,
	TOOL_HEALTH_PROBE_TIMEOUT_MS,
	type ToolHealthDeps,
	type TransitRegionHealth,
} from "./types";

type DockerLike = { ping: () => Promise<unknown> };
let dockerClient: DockerLike | null = null;

// Same construction as the file-production sandbox (src/lib/server/sandbox/
// config.ts): a bare `new Docker()` lets dockerode honour DOCKER_HOST /
// DOCKER_TLS_VERIFY / DOCKER_CERT_PATH from the environment.
async function getDockerClient(): Promise<DockerLike> {
	if (!dockerClient) {
		const { default: Docker } = await import("dockerode");
		dockerClient = new Docker();
	}
	return dockerClient;
}

export async function pingDocker(signal: AbortSignal): Promise<void> {
	const docker = await getDockerClient();
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(new Error("docker ping aborted"));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		docker.ping().then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function parseCapabilities(raw: string): Capability[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is Capability =>
			CAPABILITIES.includes(item as Capability),
		);
	} catch {
		return [];
	}
}

export async function countConnectedConnections(): Promise<ConnectedConnectionCounts> {
	const rows = await db
		.select({ capabilitiesJson: userConnections.capabilitiesJson })
		.from(userConnections)
		.where(eq(userConnections.status, "connected"));
	const counts: ConnectedConnectionCounts = {};
	for (const row of rows) {
		for (const capability of parseCapabilities(row.capabilitiesJson)) {
			counts[capability] = (counts[capability] ?? 0) + 1;
		}
	}
	return counts;
}

// Per-region public-transport readiness, straight from the routing table.
export async function listTransitRegions(): Promise<TransitRegionHealth[]> {
	return db
		.select({
			name: routingRegions.name,
			transitStatus: routingRegions.transitStatus,
		})
		.from(routingRegions);
}

export function createDefaultToolHealthDeps(): ToolHealthDeps {
	return {
		fetch: (input, init) => fetch(input, init),
		getConfig,
		dockerPing: pingDocker,
		listTransitRegions,
		countConnectedConnections,
		now: Date.now,
		timeoutMs: TOOL_HEALTH_PROBE_TIMEOUT_MS,
		registry: TOOL_HEALTH_REGISTRY,
	};
}
