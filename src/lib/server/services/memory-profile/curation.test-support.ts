import type { CurationModel } from "./curation";
import { isJsonRecord } from "./internal-json";

/** These lifecycle fixtures inject known new deltas and use their model stub to vary other outcomes. */
export function withDatedNativeFacts(model: CurationModel): CurationModel {
	return async (prompt, input, schema, thinkingMode) => {
		const result = await model(
			prompt,
			input,
			schema,
			...(thinkingMode ? ([thinkingMode] as const) : []),
		);
		if (
			!isJsonRecord(input) ||
			!Array.isArray(input.new_facts) ||
			!isJsonRecord(result) ||
			!isJsonRecord(schema.properties) ||
			!("date_correspondence" in schema.properties) ||
			"date_correspondence" in result
		)
			return result;
		return {
			...result,
			date_correspondence: input.new_facts.map(({ id }) => ({
				id,
				relation: "new",
				prior_fact_ids: [],
			})),
		};
	};
}
