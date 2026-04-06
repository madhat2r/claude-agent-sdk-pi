import { describe, it, expect } from "vitest";
import { buildPromptBlocks, contentToText } from "../src/prompt.js";
import type { Context } from "@mariozechner/pi-ai";

describe("buildPromptBlocks", () => {
	it("returns empty text block for empty context", () => {
		const context: Context = { messages: [] };
		const result = buildPromptBlocks(context, undefined);
		expect(result).toEqual([{ type: "text", text: "" }]);
	});

	it("builds user and assistant blocks", () => {
		const context = {
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
			],
		} as unknown as Context;
		const result = buildPromptBlocks(context, undefined);
		const texts = result.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
		const joined = texts.join("");
		expect(joined).toContain("USER:");
		expect(joined).toContain("Hello");
		expect(joined).toContain("ASSISTANT:");
		expect(joined).toContain("Hi there");
	});

	it("filters out errored assistant messages", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "partial response", stopReason: "error" } as any,
				{ role: "user", content: "Try again" },
			],
		};
		const result = buildPromptBlocks(context, undefined);
		const texts = result.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
		const joined = texts.join("");
		expect(joined).not.toContain("partial response");
		expect(joined).toContain("Try again");
	});

	it("filters out aborted assistant messages", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "interrupted", stopReason: "aborted" } as any,
				{ role: "user", content: "Continue" },
			],
		};
		const result = buildPromptBlocks(context, undefined);
		const texts = result.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
		const joined = texts.join("");
		expect(joined).not.toContain("interrupted");
		expect(joined).toContain("Continue");
	});

	it("inserts synthetic results for orphaned tool calls", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Do something" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me try" },
						{ type: "toolCall", id: "tc_123", name: "bash", arguments: { command: "ls" } },
					],
				} as any,
				// No toolResult for tc_123
				{ role: "user", content: "What happened?" },
			],
		};
		const result = buildPromptBlocks(context, undefined);
		const texts = result.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
		const joined = texts.join("");
		expect(joined).toContain("no result provided");
		expect(joined).toContain("tc_123");
	});

	it("does not insert synthetic results when tool results exist", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Do something" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Running" },
						{ type: "toolCall", id: "tc_456", name: "bash", arguments: { command: "ls" } },
					],
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc_456",
					toolName: "bash",
					content: "file1.ts\nfile2.ts",
				} as any,
				{ role: "user", content: "Thanks" },
			],
		};
		const result = buildPromptBlocks(context, undefined);
		const texts = result.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
		const joined = texts.join("");
		expect(joined).not.toContain("no result provided");
		expect(joined).toContain("file1.ts");
	});

	it("handles tool results in TOOL RESULT format", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Read a file" },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc_789", name: "read", arguments: { path: "/foo" } },
					],
				} as any,
				{
					role: "toolResult",
					toolCallId: "tc_789",
					toolName: "read",
					content: "file contents here",
				} as any,
			],
		};
		const result = buildPromptBlocks(context, undefined);
		const texts = result.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
		const joined = texts.join("");
		expect(joined).toContain("TOOL RESULT (historical Read, id=tc_789):");
		expect(joined).toContain("file contents here");
	});
});

describe("contentToText", () => {
	it("returns string content as-is", () => {
		expect(contentToText("hello")).toBe("hello");
	});

	it("joins text blocks", () => {
		const content = [
			{ type: "text", text: "line 1" },
			{ type: "text", text: "line 2" },
		];
		expect(contentToText(content)).toBe("line 1\nline 2");
	});

	it("formats thinking blocks", () => {
		const content = [{ type: "thinking", thinking: "reasoning here" }];
		expect(contentToText(content)).toBe("reasoning here");
	});

	it("formats tool calls", () => {
		const content = [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }];
		const result = contentToText(content);
		expect(result).toContain("Historical tool call");
		expect(result).toContain("Bash");
	});

	it("handles unknown block types", () => {
		const content = [{ type: "custom_block" }];
		expect(contentToText(content)).toBe("[custom_block]");
	});

	it("returns empty string for non-array non-string", () => {
		expect(contentToText(42 as any)).toBe("");
	});
});
