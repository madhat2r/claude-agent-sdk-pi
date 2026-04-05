import { parse as parsePartial } from "partial-json";

/** Remove unpaired Unicode surrogates that can cause API errors. */
export function sanitizeSurrogates(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"",
	);
}

/** Parse potentially incomplete JSON, falling back to `fallback` on failure. */
export function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input || input.trim() === "") return fallback;
	try {
		return JSON.parse(input) as Record<string, unknown>;
	} catch {
		try {
			const result = parsePartial(input);
			return (result ?? fallback) as Record<string, unknown>;
		} catch {
			return fallback;
		}
	}
}
