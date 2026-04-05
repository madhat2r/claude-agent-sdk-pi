import { describe, it, expect } from "vitest";
import { mapThinkingTokens } from "../src/thinking.js";

describe("mapThinkingTokens", () => {
	it("returns undefined when no reasoning level", () => {
		expect(mapThinkingTokens(undefined, "claude-sonnet-4-5-20250929")).toBeUndefined();
	});

	it("returns default budgets for non-opus models", () => {
		expect(mapThinkingTokens("minimal", "claude-sonnet-4-5-20250929")).toBe(2048);
		expect(mapThinkingTokens("low", "claude-sonnet-4-5-20250929")).toBe(8192);
		expect(mapThinkingTokens("medium", "claude-sonnet-4-5-20250929")).toBe(16384);
		expect(mapThinkingTokens("high", "claude-sonnet-4-5-20250929")).toBe(31999);
	});

	it("maps xhigh to high for non-opus models", () => {
		expect(mapThinkingTokens("xhigh", "claude-sonnet-4-5-20250929")).toBe(31999);
	});

	it("returns opus-4-6 budgets for opus models", () => {
		expect(mapThinkingTokens("minimal", "claude-opus-4-6")).toBe(2048);
		expect(mapThinkingTokens("low", "claude-opus-4-6")).toBe(8192);
		expect(mapThinkingTokens("medium", "claude-opus-4-6")).toBe(31999);
		expect(mapThinkingTokens("high", "claude-opus-4-6")).toBe(63999);
		expect(mapThinkingTokens("xhigh", "claude-opus-4-6")).toBe(63999);
	});

	it("detects opus-4.6 with dot notation", () => {
		expect(mapThinkingTokens("high", "claude-opus-4.6")).toBe(63999);
	});

	it("uses custom budgets when provided", () => {
		const custom = { medium: 10000 };
		expect(mapThinkingTokens("medium", "claude-sonnet-4-5-20250929", custom)).toBe(10000);
	});

	it("falls back to default when custom budget is invalid", () => {
		const custom = { medium: -1 };
		expect(mapThinkingTokens("medium", "claude-sonnet-4-5-20250929", custom)).toBe(16384);
	});

	it("ignores custom budgets for opus-4-6", () => {
		const custom = { high: 10000 };
		expect(mapThinkingTokens("high", "claude-opus-4-6", custom)).toBe(63999);
	});
});
