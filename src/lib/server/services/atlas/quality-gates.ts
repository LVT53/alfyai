import type { AtlasHonestyMarker } from "./types";

export interface AtlasAuditUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface AtlasAuditModelResult {
	text: string;
	usage?: AtlasAuditUsage | null;
	warning?: string | null;
}

export interface AtlasAuditBasisInput {
	assembledMarkdown: string;
	sources: Array<{ title: string; url?: string | null }>;
	limitation?: { code: string; message: string } | null;
	runAuditModel?: (prompt: string) => Promise<AtlasAuditModelResult>;
	auditModelWarning?: string | null;
}

export interface AtlasAuditBasisResult {
	passed: boolean;
	honestyMarkers: AtlasHonestyMarker[];
	retryRequested: boolean;
	usage?: AtlasAuditUsage | null;
}

function buildAuditPrompt(input: AtlasAuditBasisInput): string {
	return JSON.stringify({
		task: 'Audit this Atlas report for unsupported claims, contradictions, language drift, and source gaps. Return JSON only: {"retryRequested": boolean, "markers": [{"code": string, "message": string, "severity": "info"|"warning"|"critical"}]}',
		report: input.assembledMarkdown,
		sources: input.sources,
		limitation: input.limitation ?? null,
	});
}

function parseAuditMarkers(text: string): {
	markers: AtlasHonestyMarker[];
	retryRequested: boolean;
} {
	const trimmed = text.trim();
	if (!trimmed) return { markers: [], retryRequested: false };

	try {
		const parsed = JSON.parse(trimmed) as {
			markers?: unknown;
			retryRequested?: unknown;
		};
		const markers = Array.isArray(parsed.markers)
			? parsed.markers.flatMap((marker): AtlasHonestyMarker[] => {
					if (!marker || typeof marker !== "object") return [];
					const record = marker as Record<string, unknown>;
					const code =
						typeof record.code === "string" && record.code.trim()
							? record.code.trim()
							: "atlas_audit_marker";
					const message =
						typeof record.message === "string" && record.message.trim()
							? record.message.trim()
							: "The audit model flagged this report area.";
					const severity =
						record.severity === "critical" ||
						record.severity === "warning" ||
						record.severity === "info"
							? record.severity
							: "warning";
					return [{ code, message, severity }];
				})
			: [];
		return {
			markers,
			retryRequested: parsed.retryRequested === true,
		};
	} catch {
		return {
			markers: [
				{
					code: "atlas_audit_unstructured",
					message:
						"The audit model returned an unstructured audit; Atlas kept deterministic source checks.",
					severity: "warning",
				},
			],
			retryRequested: /retry/i.test(trimmed),
		};
	}
}

export async function auditAtlasBasis(
	input: AtlasAuditBasisInput,
): Promise<AtlasAuditBasisResult> {
	const honestyMarkers: AtlasHonestyMarker[] = [];
	if (input.auditModelWarning) {
		honestyMarkers.push({
			code: "atlas_audit_model_fallback",
			message: input.auditModelWarning,
			severity: "warning",
		});
	}
	if (input.limitation) {
		honestyMarkers.push({
			code: input.limitation.code,
			message: input.limitation.message,
			severity: "warning",
		});
	}
	if (input.sources.length === 0) {
		honestyMarkers.push({
			code: "atlas_no_sources",
			message: "Atlas could not attach external sources to this report.",
			severity: "critical",
		});
	}
	if (input.runAuditModel) {
		const audit = await input.runAuditModel(buildAuditPrompt(input));
		const parsed = parseAuditMarkers(audit.text);
		honestyMarkers.push(...parsed.markers);
		if (parsed.retryRequested) {
			honestyMarkers.push({
				code: "atlas_audit_retry_requested",
				message: "The audit model requested another Atlas round.",
				severity: "warning",
			});
			return {
				passed: false,
				honestyMarkers,
				retryRequested: true,
				usage: audit.usage ?? null,
			};
		}
		return {
			passed: !honestyMarkers.some((marker) => marker.severity === "critical"),
			honestyMarkers,
			retryRequested: false,
			usage: audit.usage ?? null,
		};
	}
	return {
		passed: !honestyMarkers.some((marker) => marker.severity === "critical"),
		honestyMarkers,
		retryRequested: false,
		usage: null,
	};
}
