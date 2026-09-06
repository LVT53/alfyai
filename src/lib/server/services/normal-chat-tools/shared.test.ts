import { asSchema } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compactModelPayload, compactToolInputSchema } from "./shared";

describe("compactModelPayload", () => {
	it("drops undefined, null, empty string, empty array and empty object values", () => {
		expect(
			compactModelPayload({
				a: undefined,
				b: null,
				c: "",
				d: [],
				e: {},
				f: "kept",
				g: 0,
				h: false,
			}),
		).toEqual({ f: "kept", g: 0, h: false });
	});

	it("never drops the protected envelope keys even when empty/falsy", () => {
		expect(
			compactModelPayload({
				success: false,
				name: "",
				action: "",
				message: "",
				mode: "",
				sourceType: "",
			}),
		).toEqual({
			success: false,
			name: "",
			action: "",
			message: "",
			mode: "",
			sourceType: "",
		});
	});

	it("recurses exactly one level into a nested plain object", () => {
		expect(
			compactModelPayload({
				answerBrief: { sourceCount: 2, evidenceCount: 0, note: "" },
			}),
		).toEqual({ answerBrief: { sourceCount: 2, evidenceCount: 0 } });
	});

	it("drops a nested object entirely once compaction leaves it empty", () => {
		expect(
			compactModelPayload({
				answerBrief: { note: "", other: null },
				kept: "value",
			}),
		).toEqual({ kept: "value" });
	});

	it("does not descend a second level (a grandchild object is left as-is)", () => {
		const payload = compactModelPayload({
			outer: { inner: { note: "", value: 1 } },
		});
		expect(payload).toEqual({ outer: { inner: { note: "", value: 1 } } });
	});

	it("leaves array items untouched (arrays are not recursed into)", () => {
		const payload = compactModelPayload({
			items: [{ note: "", value: 1 }, { value: 2 }],
		});
		expect(payload).toEqual({
			items: [{ note: "", value: 1 }, { value: 2 }],
		});
	});

	it("passes non-record payloads through unchanged", () => {
		expect(compactModelPayload("a string" as unknown)).toBe("a string");
		expect(compactModelPayload(null as unknown)).toBe(null);
		expect(compactModelPayload([1, 2, 3] as unknown)).toEqual([1, 2, 3]);
	});

	it("is idempotent — compacting an already-compacted payload changes nothing", () => {
		const once = compactModelPayload({
			success: true,
			name: "research_web",
			answerBrief: { sourceCount: 1, note: "" },
			empty: [],
		});
		const twice = compactModelPayload(once);
		expect(twice).toEqual(once);
	});
});

// The compact-schema change shows the model a trimmed JSON schema while
// keeping the full zod schema as the validator. Both halves of that claim
// need holding: the trimmed schema must not drop anything the model needs in
// order to call the tool correctly, and validation must still reject exactly
// what zod rejected before it was trimmed.
describe("compactToolInputSchema", () => {
	const schema = z.object({
		query: z.string().min(1),
		readPages: z.number().int().min(0).max(2).optional(),
		mode: z.enum(["fast", "deep"]).optional(),
	});

	type ShownSchema = {
		type?: string;
		required?: string[];
		properties?: Record<string, Record<string, unknown>>;
		additionalProperties?: unknown;
		$schema?: unknown;
	};

	function shownSchemaOf(
		compact: ReturnType<typeof compactToolInputSchema>,
	): ShownSchema {
		return asSchema(compact).jsonSchema as ShownSchema;
	}

	it("keeps the model-facing shape: every property, the required list, and enums", () => {
		const shown = shownSchemaOf(compactToolInputSchema(schema));

		expect(shown.type).toBe("object");
		expect(Object.keys(shown.properties ?? {}).sort()).toEqual([
			"mode",
			"query",
			"readPages",
		]);
		expect(shown.required).toEqual(["query"]);
		expect(shown.properties?.mode.enum).toEqual(["fast", "deep"]);
		// Real bounds a model has to respect survive the trim; only zod's
		// boilerplate (the 2^53 integer ceiling, minLength:1) is dropped.
		expect(shown.properties?.readPages.minimum).toBe(0);
		expect(shown.properties?.readPages.maximum).toBe(2);
	});

	it("strips only the token-wasting boilerplate", () => {
		const shown = shownSchemaOf(compactToolInputSchema(schema));

		expect(shown.$schema).toBeUndefined();
		expect(shown.additionalProperties).toBeUndefined();
		expect(shown.properties?.query.minLength).toBeUndefined();
	});

	it("still validates through the full zod schema, accepting what zod accepts", () => {
		const { validate } = asSchema(compactToolInputSchema(schema));
		expect(validate).toBeDefined();

		expect(validate?.({ query: "prices", readPages: 2 })).toMatchObject({
			success: true,
			value: { query: "prices", readPages: 2 },
		});
	});

	it("still rejects exactly what zod rejects, including bounds the shown schema no longer spells out", () => {
		const { validate } = asSchema(compactToolInputSchema(schema));

		const invalidInputs = [
			{ query: "" }, // minLength:1 is trimmed from the SHOWN schema only
			{ readPages: 1 }, // required `query` missing
			{ query: "x", readPages: 3 }, // above max
			{ query: "x", readPages: 1.5 }, // not an integer
			{ query: "x", mode: "sideways" }, // outside the enum
		];
		for (const invalid of invalidInputs) {
			expect(validate?.(invalid)).toMatchObject({ success: false });
		}
	});

	it("validates against the zod schema even when a different schema is shown", () => {
		// map_route shows a hand-written JSON schema in place of zod's
		// five-times-repeated place union; the validator must stay the zod one.
		const compact = compactToolInputSchema(schema, {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		const shown = shownSchemaOf(compact);
		const { validate } = asSchema(compact);

		expect(Object.keys(shown.properties ?? {})).toEqual(["query"]);
		// Never described to the model here, but still enforced.
		expect(validate?.({ query: "x", readPages: 9 })).toMatchObject({
			success: false,
		});
	});
});
