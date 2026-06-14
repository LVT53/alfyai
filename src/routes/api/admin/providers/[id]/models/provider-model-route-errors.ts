export function isProviderModelValidationError(error: unknown): error is Error {
	return (
		error instanceof Error && error.name === "ProviderModelValidationError"
	);
}
