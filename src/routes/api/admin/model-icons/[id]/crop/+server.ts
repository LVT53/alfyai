import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	CampaignAssetValidationError,
	type CampaignCropGeometry,
	saveModelIconAsset,
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

function parseCropGeometry(
	value: FormDataEntryValue | null,
): CampaignCropGeometry | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as Partial<CampaignCropGeometry>;
		if (
			typeof parsed.x !== "number" ||
			typeof parsed.y !== "number" ||
			typeof parsed.width !== "number" ||
			typeof parsed.height !== "number" ||
			typeof parsed.zoom !== "number"
		) {
			return null;
		}
		return {
			x: parsed.x,
			y: parsed.y,
			width: parsed.width,
			height: parsed.height,
			zoom: parsed.zoom,
		};
	} catch {
		return null;
	}
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
				error: "Invalid model icon crop",
				fieldErrors: { image: "Model icon crop image is required." },
			},
			{ status: 400 },
		);
	}

	const crop = parseCropGeometry(formData.get("crop"));
	if (!crop) {
		return json(
			{
				error: "Invalid model icon crop",
				fieldErrors: { crop: "Crop geometry is required." },
			},
			{ status: 400 },
		);
	}

	try {
		const width = parseOptionalPositiveInteger(formData.get("width"));
		const height = parseOptionalPositiveInteger(formData.get("height"));
		const asset = await saveModelIconAsset({
			uploadedByUserId: event.locals.user?.id,
			sourceAssetId: event.params.id,
			file: {
				filename: image.name,
				mimeType: image.type,
				content: Buffer.from(await image.arrayBuffer()),
			},
			dimensions: width && height ? { width, height } : undefined,
			crop,
		});

		return json({ asset }, { status: 201 });
	} catch (error) {
		if (error instanceof CampaignAssetValidationError) {
			return json(
				{ error: error.message, fieldErrors: error.fieldErrors },
				{ status: 400 },
			);
		}
		console.error("[CAMPAIGN_ASSETS] Failed to save model icon crop:", error);
		return json({ error: "Failed to save model icon crop." }, { status: 500 });
	}
};
