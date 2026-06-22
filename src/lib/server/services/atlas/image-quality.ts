import type { AtlasImageCandidate } from "./types";

const IMAGE_TOKEN_STOPWORDS = new Set([
	"about",
	"after",
	"ai",
	"atlas",
	"best",
	"blog",
	"chart",
	"coding",
	"diagram",
	"flowchart",
	"from",
	"image",
	"images",
	"integration",
	"into",
	"logo",
	"logos",
	"market",
	"model",
	"models",
	"photo",
	"picture",
	"process",
	"report",
	"source",
	"that",
	"this",
	"with",
]);

const LOGO_OR_ICON_TEXT_PATTERN =
	/\b(?:app\s+icon|apple-touch-icon|brand\s+mark|brandmark|devicon|favicon|icon|icons|logo|logos|logomark|mark\s+only|simple\s+icons|svg\s+icon|technology\s+icon|vector\s+icon|vector\s+logo|wordmark)\b/i;

const LOGO_OR_ICON_URL_PATTERN =
	/(?:^|[/.?&=_-])(?:apple-touch-icon|brandfetch|clearbit|devicon|favicon|flaticon|fontawesome|heroicons|icon|icons|icons8|logo|logos|logomark|material-icons|simple-icons|sprite|svgporn|svgrepo|worldvectorlogo)(?:[/.?&=_-]|$)/i;

const GENERIC_ARTICLE_IMAGE_PATTERN =
	/\b(?:abstract|article\s+(?:cover|hero|image|thumbnail)|banner|blog\s+(?:cover|header|hero|image|thumbnail)|cover\s+(?:art|image|illustration|photo)|decorative|featured\s+image|generic|header\s+image|hero\s+(?:banner|image|illustration)|illustration|stock\s+(?:art|image|illustration|photo)|thumbnail)\b/i;

const GENERIC_VISUAL_NOUN_PATTERN =
	/\b(?:diagram|flowchart|graphic|illustration|image|picture|visual|visualization)\b/i;

function normalizeImageText(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

function normalizedImageUrlText(value: string | null | undefined): string {
	if (!value) return "";
	try {
		const parsed = new URL(value);
		return normalizeImageText(
			[parsed.hostname, parsed.pathname, parsed.searchParams.toString()].join(
				" ",
			),
		);
	} catch {
		return normalizeImageText(value);
	}
}

export function atlasImageMeaningfulTokens(text: string): Set<string> {
	const tokens = normalizeImageText(text)
		.split(/[^a-z0-9]+/)
		.filter((token) => {
			if (!token) return false;
			if (/^20\d{2}$/.test(token)) return false;
			if (IMAGE_TOKEN_STOPWORDS.has(token)) return false;
			return token.length >= 3 || /\d/.test(token);
		});
	return new Set(tokens);
}

export function atlasImageTokenOverlapScore(
	leftText: string,
	rightText: string,
): number {
	const left = atlasImageMeaningfulTokens(leftText);
	const right = atlasImageMeaningfulTokens(rightText);
	let score = 0;
	for (const token of left) {
		for (const candidate of right) {
			if (
				candidate === token ||
				candidate.includes(token) ||
				token.includes(candidate)
			) {
				score += 1;
				break;
			}
		}
	}
	return score;
}

export function atlasImageCandidateEvidenceText(
	candidate: AtlasImageCandidate,
): string {
	return [
		candidate.title,
		candidate.caption,
		candidate.sourceTitle ?? "",
		normalizedImageUrlText(candidate.sourcePageUrl),
	].join(" ");
}

function atlasImageCandidateVisualText(candidate: AtlasImageCandidate): string {
	return [candidate.title, candidate.caption].join(" ");
}

function atlasImageCandidateSourceContextText(
	candidate: AtlasImageCandidate,
): string {
	return [
		candidate.sourceTitle ?? "",
		normalizedImageUrlText(candidate.sourcePageUrl),
	].join(" ");
}

function minimumQueryOverlap(query: string): number {
	const tokenCount = atlasImageMeaningfulTokens(query).size;
	if (tokenCount === 0) return 0;
	return Math.min(2, tokenCount);
}

function hasStrongQueryRelevance(candidate: AtlasImageCandidate): boolean {
	const requiredOverlap = minimumQueryOverlap(candidate.query);
	if (requiredOverlap === 0) return true;
	const visualScore = atlasImageTokenOverlapScore(
		candidate.query,
		atlasImageCandidateVisualText(candidate),
	);
	const sourceContextScore = atlasImageTokenOverlapScore(
		candidate.query,
		atlasImageCandidateSourceContextText(candidate),
	);
	return visualScore > 0 && visualScore + sourceContextScore >= requiredOverlap;
}

function hasStrongSubjectRelevance(candidate: AtlasImageCandidate): boolean {
	const requiredOverlap = minimumQueryOverlap(candidate.query);
	if (requiredOverlap === 0) return true;
	const visualScore = atlasImageTokenOverlapScore(
		candidate.query,
		atlasImageCandidateVisualText(candidate),
	);
	const sourceTitleScore = atlasImageTokenOverlapScore(
		candidate.query,
		candidate.sourceTitle ?? "",
	);
	return (
		visualScore >= Math.max(2, requiredOverlap) ||
		(visualScore >= 1 &&
			sourceTitleScore >= 1 &&
			visualScore + sourceTitleScore >= 3)
	);
}

function isLikelyGenericArticleImage(candidate: AtlasImageCandidate): boolean {
	const visualText = atlasImageCandidateVisualText(candidate);
	const sourceText = candidate.sourceTitle ?? "";
	const urlText = [
		normalizedImageUrlText(candidate.imageUrl),
		normalizedImageUrlText(candidate.thumbnailUrl),
		normalizedImageUrlText(candidate.sourcePageUrl),
	].join(" ");
	const combined = [visualText, sourceText, urlText].join(" ");
	return (
		GENERIC_ARTICLE_IMAGE_PATTERN.test(combined) ||
		(/\b(?:blog|community|medium|news|post|article)\b/i.test(sourceText) &&
			GENERIC_VISUAL_NOUN_PATTERN.test(visualText) &&
			atlasImageMeaningfulTokens(visualText).size <= 4)
	);
}

function isLikelyLogoOrIcon(candidate: AtlasImageCandidate): boolean {
	const text = [
		candidate.title,
		candidate.caption,
		candidate.sourceTitle ?? "",
		candidate.sourcePageUrl ?? "",
		candidate.imageUrl,
		candidate.thumbnailUrl ?? "",
	].join(" ");
	return (
		LOGO_OR_ICON_TEXT_PATTERN.test(text) ||
		LOGO_OR_ICON_URL_PATTERN.test(candidate.imageUrl) ||
		LOGO_OR_ICON_URL_PATTERN.test(candidate.thumbnailUrl ?? "") ||
		LOGO_OR_ICON_URL_PATTERN.test(candidate.sourcePageUrl ?? "")
	);
}

function isLikelySvgOrIconFile(candidate: AtlasImageCandidate): boolean {
	const urls = [
		candidate.imageUrl,
		candidate.thumbnailUrl ?? "",
		candidate.sourcePageUrl ?? "",
	];
	return urls.some((url) => /\.(?:ico|svg)(?:[?#]|$)/i.test(url));
}

function isTooSmallForReport(candidate: AtlasImageCandidate): boolean {
	if (candidate.width === null || candidate.height === null) return false;
	return candidate.width < 320 || candidate.height < 180;
}

export function isUsableAtlasImageCandidate(
	candidate: AtlasImageCandidate,
): boolean {
	if (isLikelySvgOrIconFile(candidate)) return false;
	if (isLikelyLogoOrIcon(candidate)) return false;
	if (isTooSmallForReport(candidate)) return false;
	if (
		isLikelyGenericArticleImage(candidate) &&
		!hasStrongSubjectRelevance(candidate)
	) {
		return false;
	}
	return hasStrongQueryRelevance(candidate);
}
