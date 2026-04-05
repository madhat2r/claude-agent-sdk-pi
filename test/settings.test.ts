import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeAgentsContent, extractSkillsAppend, rewriteSkillsLocations } from "../src/settings.js";

describe("sanitizeAgentsContent", () => {
	it("rewrites ~/.pi to ~/.claude", () => {
		expect(sanitizeAgentsContent("check ~/.pi/agent")).toBe("check ~/.claude/agent");
	});

	it("rewrites .pi/ directory references", () => {
		expect(sanitizeAgentsContent("look in .pi/settings.json")).toBe("look in .claude/settings.json");
	});

	it("rewrites .pi to .claude", () => {
		expect(sanitizeAgentsContent("the .pi directory")).toBe("the .claude directory");
	});

	it("does not corrupt unrelated content", () => {
		// The word "pi" by itself is no longer replaced (aggressive regex removed)
		const input = "Calculate pi to 10 digits";
		const result = sanitizeAgentsContent(input);
		expect(result).toBe("Calculate pi to 10 digits");
	});

	it("does not affect URLs", () => {
		const input = "Visit https://api.example.com/endpoint";
		expect(sanitizeAgentsContent(input)).toBe("Visit https://api.example.com/endpoint");
	});

	it("handles multiple replacements", () => {
		const input = "Edit ~/.pi/config and .pi/local.json";
		const result = sanitizeAgentsContent(input);
		expect(result).toContain("~/.claude/config");
		expect(result).toContain(".claude/local.json");
	});
});

describe("extractSkillsAppend", () => {
	it("returns undefined for empty prompt", () => {
		expect(extractSkillsAppend(undefined)).toBeUndefined();
		expect(extractSkillsAppend("")).toBeUndefined();
	});

	it("returns undefined when no skills block", () => {
		expect(extractSkillsAppend("Just a regular system prompt")).toBeUndefined();
	});

	it("extracts skills block with markers", () => {
		const prompt =
			"Some preamble. The following skills provide specialized instructions for specific tasks.\n" +
			'<skill name="test">do stuff</skill>\n' +
			"</available_skills>\nSome postamble.";
		const result = extractSkillsAppend(prompt);
		expect(result).toBeDefined();
		expect(result).toContain("specialized instructions");
		expect(result).toContain("</available_skills>");
		expect(result).not.toContain("Some postamble");
	});
});

describe("rewriteSkillsLocations", () => {
	it("leaves non-location content unchanged", () => {
		expect(rewriteSkillsLocations("no locations here")).toBe("no locations here");
	});

	it("rewrites location tags with unmatched paths unchanged", () => {
		const input = "<location>/some/random/path</location>";
		expect(rewriteSkillsLocations(input)).toBe("<location>/some/random/path</location>");
	});
});
