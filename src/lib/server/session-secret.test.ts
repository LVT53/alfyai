import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetSessionSecretWarningForTests,
	assertSessionSecret,
	DEV_FALLBACK_SESSION_SECRET,
	inspectSessionSecret,
	isProductionRuntime,
	KNOWN_PLACEHOLDER_SESSION_SECRETS,
	resolveSessionSecret,
	SESSION_SECRET_MIN_LENGTH,
} from "./session-secret";

const REAL_SECRET =
	"3f8a1c0b9d4e7f2a6b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a";

/** A production environment with nothing else in it. */
function productionEnv(
	overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
	return { NODE_ENV: "production", ...overrides } as NodeJS.ProcessEnv;
}

describe("inspectSessionSecret", () => {
	it("accepts a real secret", () => {
		expect(inspectSessionSecret(REAL_SECRET)).toBeNull();
	});

	it("rejects a missing or empty secret", () => {
		expect(inspectSessionSecret(undefined)).toBe("missing");
		expect(inspectSessionSecret("")).toBe("missing");
		// The original bug: `process.env.SESSION_SECRET || fallback` treats an
		// empty assignment in .env as unset and silently falls back.
		expect(inspectSessionSecret("   ")).toBe("missing");
	});

	it("rejects anything shorter than the minimum", () => {
		expect(
			inspectSessionSecret("a".repeat(SESSION_SECRET_MIN_LENGTH - 1)),
		).toBe("too-short");
		expect(
			inspectSessionSecret("a".repeat(SESSION_SECRET_MIN_LENGTH)),
		).toBeNull();
	});

	it("rejects every placeholder that ships in this repository", () => {
		for (const placeholder of KNOWN_PLACEHOLDER_SESSION_SECRETS) {
			expect(inspectSessionSecret(placeholder)).toBe("known-placeholder");
		}
	});

	it("rejects the .env.example placeholder even though it is long enough", () => {
		// 33 characters — a naive length check would wave it through, which is
		// the whole reason the placeholder list exists.
		const example = "change-me-to-a-random-long-secret";
		expect(example.length).toBeGreaterThanOrEqual(SESSION_SECRET_MIN_LENGTH);
		expect(inspectSessionSecret(example)).toBe("known-placeholder");
	});

	it("sees through surrounding whitespace", () => {
		expect(inspectSessionSecret(`  ${DEV_FALLBACK_SESSION_SECRET}  `)).toBe(
			"known-placeholder",
		);
	});
});

describe("isProductionRuntime", () => {
	it("is true only for NODE_ENV=production outside the test harnesses", () => {
		expect(isProductionRuntime(productionEnv())).toBe(true);
		expect(isProductionRuntime({ NODE_ENV: "development" })).toBe(false);
		expect(isProductionRuntime({})).toBe(false);
		expect(isProductionRuntime(productionEnv({ PLAYWRIGHT_TEST: "1" }))).toBe(
			false,
		);
		expect(isProductionRuntime(productionEnv({ VITEST: "true" }))).toBe(false);
	});

	it("does not treat PLAYWRIGHT_TEST=0 as a test harness", () => {
		expect(isProductionRuntime(productionEnv({ PLAYWRIGHT_TEST: "0" }))).toBe(
			true,
		);
	});
});

describe("assertSessionSecret", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		_resetSessionSecretWarningForTests();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
	});

	it("passes silently on a real secret in production", () => {
		expect(() =>
			assertSessionSecret(productionEnv({ SESSION_SECRET: REAL_SECRET })),
		).not.toThrow();
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		["missing", undefined],
		["empty", ""],
		["too short", "short-secret"],
		["the dev placeholder", DEV_FALLBACK_SESSION_SECRET],
		["the .env.example placeholder", "change-me-to-a-random-long-secret"],
	])("refuses to start in production when the secret is %s", (_label, value) => {
		expect(() =>
			assertSessionSecret(productionEnv({ SESSION_SECRET: value })),
		).toThrow(/refusing to start/i);
	});

	it("tells the operator exactly what to do", () => {
		let message = "";
		try {
			assertSessionSecret(productionEnv());
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("SESSION_SECRET");
		expect(message).toContain("openssl rand -hex 32");
		// The blast radius has to be in the message, because the operator's
		// instinct on seeing this at 3am is to invent a new secret — which would
		// make every stored credential undecryptable.
		expect(message).toContain("undecryptable");
	});

	it("warns once, and does not throw, outside production", () => {
		expect(() =>
			assertSessionSecret({ NODE_ENV: "development" }),
		).not.toThrow();
		expect(() =>
			assertSessionSecret({ NODE_ENV: "development" }),
		).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(
			"INSECURE SESSION_SECRET",
		);
	});

	it("does not throw under the Playwright harness even with NODE_ENV=production", () => {
		expect(() =>
			assertSessionSecret(productionEnv({ PLAYWRIGHT_TEST: "1" })),
		).not.toThrow();
	});
});

describe("resolveSessionSecret", () => {
	it("returns the operator's secret verbatim", () => {
		expect(resolveSessionSecret({ SESSION_SECRET: REAL_SECRET })).toBe(
			REAL_SECRET,
		);
	});

	it("does not trim, so the PBKDF2 input never changes under an existing box", () => {
		// Validation trims before judging; key derivation must not. Trimming here
		// would silently make every stored connection secret and provider API key
		// on a box whose secret carries whitespace fail to decrypt.
		const padded = ` ${REAL_SECRET} `;
		expect(resolveSessionSecret({ SESSION_SECRET: padded })).toBe(padded);
	});

	it("falls back to the development literal when unset", () => {
		expect(resolveSessionSecret({})).toBe(DEV_FALLBACK_SESSION_SECRET);
		expect(resolveSessionSecret({ SESSION_SECRET: "" })).toBe(
			DEV_FALLBACK_SESSION_SECRET,
		);
	});
});
