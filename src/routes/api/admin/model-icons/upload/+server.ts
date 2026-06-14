import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	CampaignAssetValidationError,
	storeModelIconAsset,
} from "$lib/server/services/campaign-assets";
import type { RequestHandler } from "./$types";

function parseOptionalPositiveInteger(
	value: FormDataEntryValue | null,
): number | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as File).arrayBuffer === "function" &&
		typeof (value as File).name === "string"
	);
}

function uploadMimeType(file: File): string {
	if (file.type) return file.type;
	return file.name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : file.type;
}

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	let formData: FormData;
	try {
		formData = await event.request.formData();
	} catch {
		return json(
			{
				error: "Invalid form data",
				fieldErrors: { form: "Invalid form data." },
			},
			{ status: 400 },
		);
	}

	const image = formData.get("image");
	if (!isUploadFile(image)) {
		return json(
			{
				error: "Invalid model icon upload",
				fieldErrors: { image: "Model icon image is required." },
			},
			{ status: 400 },
		);
	}

	try {
		const width = parseOptionalPositiveInteger(formData.get("width"));
		const height = parseOptionalPositiveInteger(formData.get("height"));
		const asset = await storeModelIconAsset({
			uploadedByUserId: event.locals.user?.id,
			file: {
				filename: image.name,
				mimeType: uploadMimeType(image),
				content: Buffer.from(await image.arrayBuffer()),
			},
			dimensions: width && height ? { width, height } : undefined,
		});

		return json({ asset }, { status: 201 });
	} catch (error) {
		if (error instanceof CampaignAssetValidationError) {
			return json(
				{ error: error.message, fieldErrors: error.fieldErrors },
				{ status: 400 },
			);
		}
		console.error("[CAMPAIGN_ASSETS] Failed to upload model icon:", error);
		return json({ error: "Failed to upload model icon." }, { status: 500 });
	}
};
