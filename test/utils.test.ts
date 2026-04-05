import { describe, it, expect } from "vitest";
import { sanitizeSurrogates, parsePartialJson } from "../src/utils.js";

describe("sanitizeSurrogates", () => {
	it("passes through normal text unchanged", () => {
		expect(sanitizeSurrogates("hello world")).toBe("hello world");
	});

	it("passes through valid surrogate pairs (emoji)", () => {
		expect(sanitizeSurrogates("hello 😀 world")).toBe("hello 😀 world");
	});

	it("removes unpaired high surrogates", () => {
		expect(sanitizeSurrogates("hello \uD800 world")).toBe("hello  world");
	});

	it("removes unpaired low surrogates", () => {
		expect(sanitizeSurrogates("hello \uDC00 world")).toBe("hello  world");
	});

	it("handles empty string", () => {
		expect(sanitizeSurrogates("")).toBe("");
	});
});

describe("parsePartialJson", () => {
	it("parses valid JSON", () => {
		expect(parsePartialJson('{"a": 1}', {})).toEqual({ a: 1 });
	});

	it("returns fallback for empty string", () => {
		const fallback = { x: 1 };
		expect(parsePartialJson("", fallback)).toBe(fallback);
	});

	it("returns fallback for whitespace-only string", () => {
		const fallback = { x: 1 };
		expect(parsePartialJson("   ", fallback)).toBe(fallback);
	});

	it("parses partial JSON via partial-json", () => {
		const result = parsePartialJson('{"a": 1, "b": "he', {});
		expect(result).toHaveProperty("a", 1);
		expect(result).toHaveProperty("b", "he");
	});

	it("returns fallback for completely invalid input", () => {
		const fallback = { x: 1 };
		expect(parsePartialJson("not json at all {{{", fallback)).toBe(fallback);
	});
});
