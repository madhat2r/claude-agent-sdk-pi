import { describe, it, expect, beforeEach } from "vitest";
import type { Context } from "@mariozechner/pi-ai";
import {
	TOOL_WATCH_CUSTOM_TYPE,
	sessionKeyFromId,
	getActiveSessionKey,
	setActiveSessionKey,
	deleteSessionState,
	hydrateFromEntries,
	reconcileWithContext,
	buildToolWatchNote,
	handleMessageEnd,
	handleToolExecutionStart,
	handleToolExecutionEnd,
	_resetAllState,
	_getState,
} from "../src/ledger.js";

const SK = "session:test-session";

beforeEach(() => {
	_resetAllState();
});

describe("session key helpers", () => {
	it("builds session key from id", () => {
		expect(sessionKeyFromId("abc")).toBe("session:abc");
	});

	it("manages active session key", () => {
		expect(getActiveSessionKey()).toBeUndefined();
		setActiveSessionKey(SK);
		expect(getActiveSessionKey()).toBe(SK);
		setActiveSessionKey(undefined);
		expect(getActiveSessionKey()).toBeUndefined();
	});

	it("deletes session state", () => {
		handleToolExecutionStart(SK, "tc1", "bash");
		expect(_getState(SK)).toBeDefined();
		deleteSessionState(SK);
		expect(_getState(SK)).toBeUndefined();
	});
});

describe("handleToolExecutionStart / handleToolExecutionEnd", () => {
	it("tracks pending then completes", () => {
		handleToolExecutionStart(SK, "tc1", "bash");
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(true);
		expect(state.completedToolCalls.has("tc1")).toBe(false);

		const entry = handleToolExecutionEnd(SK, "tc1", "bash", { content: [{ type: "text", text: "ok" }] }, false);
		expect(entry.type).toBe("tool_execution_end");
		expect(entry.toolCallId).toBe("tc1");
		expect(entry.content).toContain("ok");
		expect(state.pendingToolCalls.has("tc1")).toBe(false);
		expect(state.completedToolCalls.has("tc1")).toBe(true);
	});

	it("does not overwrite completed with pending", () => {
		handleToolExecutionEnd(SK, "tc1", "bash", "done", false);
		handleToolExecutionStart(SK, "tc1", "bash");
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(false);
		expect(state.completedToolCalls.has("tc1")).toBe(true);
	});
});

describe("handleMessageEnd", () => {
	it("tracks assistant tool calls as pending", () => {
		handleMessageEnd(SK, {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tc1", name: "read" },
				{ type: "toolCall", id: "tc2", name: "bash" },
			],
			timestamp: 1000,
		});
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(true);
		expect(state.pendingToolCalls.has("tc2")).toBe(true);
	});

	it("tracks tool results as completed", () => {
		handleToolExecutionStart(SK, "tc1", "read");
		handleMessageEnd(SK, {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: "file contents",
			isError: false,
			timestamp: 2000,
		});
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(false);
		expect(state.completedToolCalls.has("tc1")).toBe(true);
	});

	it("ignores non-object messages", () => {
		handleMessageEnd(SK, null);
		handleMessageEnd(SK, "string");
		expect(_getState(SK)).toBeUndefined();
	});
});

describe("hydrateFromEntries", () => {
	it("hydrates from message entries", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
					timestamp: 1000,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: "output",
					isError: false,
					timestamp: 2000,
				},
			},
		];

		hydrateFromEntries(SK, entries);
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.size).toBe(0);
		expect(state.completedToolCalls.has("tc1")).toBe(true);
	});

	it("hydrates from custom tool watch entries", () => {
		const entries = [
			{
				type: "custom",
				customType: TOOL_WATCH_CUSTOM_TYPE,
				data: {
					type: "tool_execution_end",
					toolCallId: "tc1",
					toolName: "read",
					content: "recovered content",
					isError: false,
					timestamp: 3000,
				},
			},
		];

		hydrateFromEntries(SK, entries);
		const state = _getState(SK)!;
		expect(state.completedToolCalls.has("tc1")).toBe(true);
		expect(state.completedToolCalls.get("tc1")!.content).toContain("recovered content");
	});

	it("leaves pending for assistant tool calls without results", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
					timestamp: 1000,
				},
			},
		];

		hydrateFromEntries(SK, entries);
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(true);
		expect(state.completedToolCalls.has("tc1")).toBe(false);
	});

	it("resets state on re-hydration", () => {
		handleToolExecutionStart(SK, "old", "bash");
		hydrateFromEntries(SK, []);
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.size).toBe(0);
		expect(state.completedToolCalls.size).toBe(0);
	});

	it("skips invalid entries", () => {
		hydrateFromEntries(SK, [null, undefined, "string", 42, { type: "unknown" }]);
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.size).toBe(0);
		expect(state.completedToolCalls.size).toBe(0);
	});
});

describe("reconcileWithContext", () => {
	it("marks pending tool calls from context assistant messages", () => {
		hydrateFromEntries(SK, []);
		const context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
				},
			],
		} as unknown as Context;

		reconcileWithContext(SK, context);
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(true);
	});

	it("removes pending and adds completed for tool results", () => {
		hydrateFromEntries(SK, []);
		handleToolExecutionStart(SK, "tc1", "bash");

		const context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: "output",
					isError: false,
				},
			],
		} as unknown as Context;

		reconcileWithContext(SK, context);
		const state = _getState(SK)!;
		expect(state.pendingToolCalls.has("tc1")).toBe(false);
		expect(state.completedToolCalls.has("tc1")).toBe(true);
	});

	it("does nothing if no state exists", () => {
		const context = { messages: [] } as unknown as Context;
		// Should not throw
		reconcileWithContext(SK, context);
		expect(_getState(SK)).toBeUndefined();
	});
});

describe("buildToolWatchNote", () => {
	it("returns undefined for no session key", () => {
		const context = { messages: [] } as unknown as Context;
		expect(buildToolWatchNote(undefined, context)).toBeUndefined();
	});

	it("returns undefined when no state exists", () => {
		const context = { messages: [] } as unknown as Context;
		expect(buildToolWatchNote(SK, context)).toBeUndefined();
	});

	it("returns undefined when all tool results are in context", () => {
		hydrateFromEntries(SK, [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
					timestamp: 1000,
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: "output",
					isError: false,
					timestamp: 2000,
				},
			},
		]);

		const context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: "output",
				},
			],
		} as unknown as Context;

		expect(buildToolWatchNote(SK, context)).toBeUndefined();
	});

	it("returns recovered note when tool result is missing from context", () => {
		// Hydrate with assistant tool call + completed execution (from custom entry)
		hydrateFromEntries(SK, [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
					timestamp: 1000,
				},
			},
			{
				type: "custom",
				customType: TOOL_WATCH_CUSTOM_TYPE,
				data: {
					type: "tool_execution_end",
					toolCallId: "tc1",
					toolName: "bash",
					content: "recovered output",
					isError: false,
					timestamp: 2000,
				},
			},
		]);

		// Context has assistant message but no tool result
		const context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "bash" }],
				},
			],
		} as unknown as Context;

		const note = buildToolWatchNote(SK, context);
		expect(note).toBeDefined();
		expect(note).toContain("recovered");
		expect(note).toContain("Bash");
		expect(note).toContain("tc1");
		expect(note).toContain("recovered output");
	});

	it("returns missing execution note for unresolved tool calls", () => {
		hydrateFromEntries(SK, [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read" }],
					timestamp: 1000,
				},
			},
		]);

		const context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read" }],
				},
			],
		} as unknown as Context;

		const note = buildToolWatchNote(SK, context);
		expect(note).toBeDefined();
		expect(note).toContain("missing execution");
		expect(note).toContain("Read");
		expect(note).toContain("tc1");
		expect(note).toContain("Call the tool again");
	});

	it("uses custom tool name mapping", () => {
		hydrateFromEntries(SK, [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "myTool" }],
					timestamp: 1000,
				},
			},
		]);

		const context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "myTool" }],
				},
			],
		} as unknown as Context;

		const customMap = new Map([["myTool", "mcp__custom-tools__myTool"]]);
		const note = buildToolWatchNote(SK, context, customMap);
		expect(note).toContain("mcp__custom-tools__myTool");
	});
});
