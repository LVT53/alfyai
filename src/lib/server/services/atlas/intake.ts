import type {
	CreateOrReuseAtlasJobInput,
	CreateOrReuseAtlasJobResult,
} from "./job-ledger";

export type SubmitAtlasJobIntakeInput = CreateOrReuseAtlasJobInput;
export type AtlasJobIntakeResult = CreateOrReuseAtlasJobResult;

export interface SubmitAtlasJobIntakeDependencies {
	createOrReuseAtlasJob: (
		input: CreateOrReuseAtlasJobInput,
	) => Promise<CreateOrReuseAtlasJobResult>;
}

export async function submitAtlasJobIntakeWithDependencies(
	input: SubmitAtlasJobIntakeInput,
	dependencies: SubmitAtlasJobIntakeDependencies,
): Promise<AtlasJobIntakeResult> {
	return dependencies.createOrReuseAtlasJob(input);
}
