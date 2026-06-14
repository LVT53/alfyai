import { createHmac, timingSafeEqual } from "node:crypto";
import { error, redirect } from "@sveltejs/kit";
import { config } from "$lib/server/env";

type AuthenticatedEvent<T extends { locals: App.Locals }> = T & {
	locals: T["locals"] & { user: NonNullable<App.Locals["user"]> };
};

export function requireAuth<T extends { locals: App.Locals }>(
	event: T,
): asserts event is AuthenticatedEvent<T> {
	if (!event.locals.user) {
		throw redirect(302, "/login");
	}
}

export function getBearerToken(
	authorizationHeader: string | null,
): string | null {
	if (!authorizationHeader) return null;

	const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);
	if (rest.length > 0) return null;
	if (!scheme || !token) return null;
	if (scheme.toLowerCase() !== "bearer") return null;

	return token;
}

type ServiceAssertionClaims = {
	conversationId: string;
	userId?: string;
	audience?: string;
	exp: number;
};

type VerifyServiceAssertionOptions = {
	expectedAudience?: string;
};

function decodeBase64Url(input: string): string | null {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padding = normalized.length % 4;
	const withPadding =
		padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;

	try {
		return Buffer.from(withPadding, "base64").toString("utf-8");
	} catch {
		return null;
	}
}

function isValidServiceAssertionClaims(
	value: unknown,
): value is ServiceAssertionClaims {
	if (!value || typeof value !== "object") return false;
	const claims = value as Record<string, unknown>;

	return (
		typeof claims.conversationId === "string" &&
		claims.conversationId.trim().length > 0 &&
		(claims.userId === undefined ||
			(typeof claims.userId === "string" && claims.userId.trim().length > 0)) &&
		(claims.audience === undefined ||
			(typeof claims.audience === "string" &&
				claims.audience.trim().length > 0)) &&
		typeof claims.exp === "number" &&
		Number.isFinite(claims.exp)
	);
}

export function verifyServiceAssertion(
	authorizationHeader: string | null,
	options: VerifyServiceAssertionOptions = {},
):
	| { valid: true; claims: ServiceAssertionClaims }
	| { valid: false; reason: string } {
	const signingKey = config.alfyaiApiSigningKey.trim();
	if (!signingKey) {
		return { valid: false, reason: "signing_key_missing" };
	}

	const token = getBearerToken(authorizationHeader);
	if (!token) {
		return { valid: false, reason: "missing_token" };
	}

	const [payloadPart, signaturePart, ...rest] = token.split(".");
	if (!payloadPart || !signaturePart || rest.length > 0) {
		return { valid: false, reason: "invalid_format" };
	}

	const expectedSignature = createHmac("sha256", signingKey)
		.update(payloadPart)
		.digest("base64url");

	const expectedBuffer = Buffer.from(expectedSignature);
	const providedBuffer = Buffer.from(signaturePart);
	if (expectedBuffer.length !== providedBuffer.length) {
		return { valid: false, reason: "invalid_signature_length" };
	}

	if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
		return { valid: false, reason: "invalid_signature" };
	}

	const payloadJson = decodeBase64Url(payloadPart);
	if (!payloadJson) {
		return { valid: false, reason: "invalid_payload_encoding" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		return { valid: false, reason: "invalid_payload_json" };
	}

	if (!isValidServiceAssertionClaims(parsed)) {
		return { valid: false, reason: "invalid_claims" };
	}

	if (parsed.exp <= Date.now()) {
		return { valid: false, reason: "expired" };
	}

	if (
		options.expectedAudience &&
		parsed.audience !== options.expectedAudience
	) {
		return {
			valid: false,
			reason: parsed.audience ? "invalid_audience" : "missing_audience",
		};
	}

	return { valid: true, claims: parsed };
}

export function verifyFileProductionServiceAssertion(
	authorizationHeader: string | null,
):
	| { valid: true; claims: ServiceAssertionClaims }
	| { valid: false; reason: string } {
	return verifyServiceAssertion(authorizationHeader);
}

export function requireAdmin(event) {
	if (!event.locals.user) {
		throw redirect(302, "/login");
	}
	if (event.locals.user.role !== "admin") {
		throw error(403, "Forbidden");
	}
}

export function requireGuest(event) {
	if (event.locals.user) {
		throw redirect(302, "/");
	}
}
