import type { Context } from "@mariozechner/pi-ai";
import { mapPiToolNameToSdk } from "./tools.js";

// --- Constants ---

export const TOOL_WATCH_CUSTOM_TYPE = "claude-agent-sdk-tool-watch";
const MAX_TRACKED_TOOL_EXECUTIONS = 256;
const MAX_TRACKED_TOOL_CONTENT_CHARS = 4000;
const MAX_LEDGER_TOOL_RESULTS = 4;
const MAX_LEDGER_TOOL_CONTENT_CHARS = 1200;

// --- Types ---

export type ToolWatchCustomEntryData = {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type PendingToolCall = {
	toolName: string;
	timestamp: number;
};

type TrackedToolExecution = {
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
	timestamp: number;
};

type SessionToolWatchState = {
	pendingToolCalls: Map<string, PendingToolCall>;
	completedToolCalls: Map<string, TrackedToolExecution>;
};

// --- Module state ---

const toolWatchStateBySession = new Map<string, SessionToolWatchState>();
let activeSessionKey: string | undefined;

// --- Session key helpers ---

export function sessionKeyFromId(sessionId: string): string {
	return `session:${sessionId}`;
}

export function getActiveSessionKey(): string | undefined {
	return activeSessionKey;
}

export function setActiveSessionKey(key: string | undefined): void {
	activeSessionKey = key;
}

export function deleteSessionState(sessionKey: string): void {
	toolWatchStateBySession.delete(sessionKey);
}

// --- Internal helpers ---

function createEmptyState(): SessionToolWatchState {
	return { pendingToolCalls: new Map(), completedToolCalls: new Map() };
}

function getOrCreateState(sessionKey: string): SessionToolWatchState {
	const existing = toolWatchStateBySession.get(sessionKey);
	if (existing) return existing;
	const created = createEmptyState();
	toolWatchStateBySession.set(sessionKey, created);
	return created;
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated]`;
}

function contentToPlainText(
	content: string | Array<{ type?: string; text?: string; mimeType?: string }> | undefined,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "image") return `[image:${block.mimeType ?? "unknown"}]`;
			if (block?.type) return `[${block.type}]`;
			return "";
		})
		.filter((line) => line.length > 0)
		.join("\n");
}

function extractToolExecutionContent(result: unknown): string {
	if (result && typeof result === "object" && "content" in result) {
		const obj = result as { content?: unknown };
		const text = contentToPlainText(
			Array.isArray(obj.content)
				? (obj.content as Array<{ type?: string; text?: string; mimeType?: string }>)
				: undefined,
		);
		if (text) return truncateText(text, MAX_TRACKED_TOOL_CONTENT_CHARS);
	}
	const fallback = typeof result === "string" ? result : JSON.stringify(result ?? "");
	return truncateText(fallback, MAX_TRACKED_TOOL_CONTENT_CHARS);
}

/** Extract tool call ids and names from an assistant message's content array. */
function collectAssistantToolCalls(message: unknown): Array<{ id: string; name: string }> {
	if (!message || typeof message !== "object") return [];
	const msg = message as { role?: string; content?: Array<{ type?: string; id?: string; name?: string }> };
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
	return msg.content
		.filter(
			(block): block is { type: "toolCall"; id: string; name: string } =>
				block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string",
		)
		.map((block) => ({ id: block.id, name: block.name }));
}

// --- Tracking ---

function trackPending(sessionKey: string, toolCallId: string, toolName: string, timestamp: number): void {
	const state = getOrCreateState(sessionKey);
	if (state.completedToolCalls.has(toolCallId)) return;
	state.pendingToolCalls.set(toolCallId, { toolName, timestamp });
}

function trackCompleted(sessionKey: string, execution: TrackedToolExecution): void {
	const state = getOrCreateState(sessionKey);
	state.pendingToolCalls.delete(execution.toolCallId);
	state.completedToolCalls.delete(execution.toolCallId);
	state.completedToolCalls.set(execution.toolCallId, execution);
	while (state.completedToolCalls.size > MAX_TRACKED_TOOL_EXECUTIONS) {
		const oldestKey = state.completedToolCalls.keys().next().value;
		if (!oldestKey) break;
		state.completedToolCalls.delete(oldestKey);
	}
}

// --- Hydration from session entries ---

export function hydrateFromEntries(sessionKey: string, entries: unknown[]): void {
	toolWatchStateBySession.set(sessionKey, createEmptyState());
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;

		if (e.type === "message") {
			const message = e.message as Record<string, unknown> | undefined;
			if (!message) continue;
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();

			if (message.role === "assistant") {
				for (const toolCall of collectAssistantToolCalls(message)) {
					trackPending(sessionKey, toolCall.id, toolCall.name, timestamp);
				}
				continue;
			}
			if (message.role === "toolResult") {
				const toolCallId = message.toolCallId as string | undefined;
				const toolName = message.toolName as string | undefined;
				if (toolCallId && toolName) {
					trackCompleted(sessionKey, {
						toolCallId,
						toolName,
						content: truncateText(
							contentToPlainText(message.content as Parameters<typeof contentToPlainText>[0]),
							MAX_TRACKED_TOOL_CONTENT_CHARS,
						),
						isError: message.isError === true,
						timestamp,
					});
				}
			}
			continue;
		}

		if (e.type === "custom" && e.customType === TOOL_WATCH_CUSTOM_TYPE) {
			const data = e.data as ToolWatchCustomEntryData | undefined;
			if (!data || data.type !== "tool_execution_end") continue;
			if (!data.toolCallId || !data.toolName) continue;
			trackCompleted(sessionKey, {
				toolCallId: data.toolCallId,
				toolName: data.toolName,
				content: truncateText(data.content ?? "", MAX_TRACKED_TOOL_CONTENT_CHARS),
				isError: data.isError === true,
				timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
			});
		}
	}
}

// --- Reconcile with current context ---

export function reconcileWithContext(sessionKey: string, context: Context): void {
	const state = toolWatchStateBySession.get(sessionKey);
	if (!state) return;

	for (const message of context.messages) {
		const msg = message as unknown as Record<string, unknown>;
		const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		if (message.role === "assistant") {
			for (const toolCall of collectAssistantToolCalls(message)) {
				if (!state.completedToolCalls.has(toolCall.id)) {
					trackPending(sessionKey, toolCall.id, toolCall.name, timestamp);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const toolCallId = msg.toolCallId as string | undefined;
			if (toolCallId) {
				state.pendingToolCalls.delete(toolCallId);
				if (!state.completedToolCalls.has(toolCallId)) {
					trackCompleted(sessionKey, {
						toolCallId,
						toolName: message.toolName,
						content: truncateText(
							contentToPlainText(message.content as Parameters<typeof contentToPlainText>[0]),
							MAX_TRACKED_TOOL_CONTENT_CHARS,
						),
						isError: (msg.isError as boolean) ?? false,
						timestamp,
					});
				}
			}
		}
	}
}

// --- Build prompt note for recovered results ---

export function buildToolWatchNote(
	sessionKey: string | undefined,
	context: Context,
	customToolNameToSdk?: Map<string, string>,
): string | undefined {
	if (!sessionKey) return undefined;
	const state = toolWatchStateBySession.get(sessionKey);
	if (!state) return undefined;

	const toolResultIdsInContext = new Set<string>();
	const assistantToolIdsInContext = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const toolCall of collectAssistantToolCalls(message)) {
				assistantToolIdsInContext.add(toolCall.id);
			}
			continue;
		}
		if (message.role === "toolResult") {
			const toolCallId = (message as unknown as Record<string, unknown>).toolCallId as string | undefined;
			if (toolCallId) toolResultIdsInContext.add(toolCallId);
		}
	}

	const recoveredExecutions = Array.from(state.completedToolCalls.values())
		.filter((execution) => {
			if (toolResultIdsInContext.has(execution.toolCallId)) return false;
			return assistantToolIdsInContext.has(execution.toolCallId) || state.pendingToolCalls.has(execution.toolCallId);
		})
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, MAX_LEDGER_TOOL_RESULTS);

	const unresolvedToolCalls = Array.from(state.pendingToolCalls.entries())
		.filter(([toolCallId]) => {
			if (toolResultIdsInContext.has(toolCallId)) return false;
			return assistantToolIdsInContext.has(toolCallId);
		})
		.sort((a, b) => b[1].timestamp - a[1].timestamp)
		.slice(0, MAX_LEDGER_TOOL_RESULTS);

	if (!recoveredExecutions.length && !unresolvedToolCalls.length) return undefined;

	const parts: string[] = [];

	for (const execution of recoveredExecutions) {
		const sdkToolName = mapPiToolNameToSdk(execution.toolName, customToolNameToSdk);
		const status = execution.isError ? "error" : "ok";
		const content = truncateText(execution.content || "(empty tool result)", MAX_LEDGER_TOOL_CONTENT_CHARS);
		parts.push(`TOOL RESULT (recovered ${sdkToolName}, id=${execution.toolCallId}, status=${status}):\n${content}`);
	}

	for (const [toolCallId, pending] of unresolvedToolCalls) {
		const sdkToolName = mapPiToolNameToSdk(pending.toolName, customToolNameToSdk);
		parts.push(
			`TOOL RESULT (missing execution ${sdkToolName}, id=${toolCallId}, status=error):\n` +
				"Tool execution did not complete or its result was not observed. Do not guess. Call the tool again.",
		);
	}

	return parts.join("\n\n");
}

// --- Event handler helpers (called from index.ts) ---

export function handleMessageEnd(sessionKey: string, message: unknown): void {
	if (!message || typeof message !== "object") return;
	const msg = message as Record<string, unknown>;
	const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

	if (msg.role === "assistant") {
		for (const toolCall of collectAssistantToolCalls(message)) {
			trackPending(sessionKey, toolCall.id, toolCall.name, timestamp);
		}
		return;
	}

	if (msg.role === "toolResult") {
		const toolCallId = msg.toolCallId as string | undefined;
		const toolName = msg.toolName as string | undefined;
		if (!toolCallId || !toolName) return;
		trackCompleted(sessionKey, {
			toolCallId,
			toolName,
			content: truncateText(
				contentToPlainText(msg.content as Parameters<typeof contentToPlainText>[0]),
				MAX_TRACKED_TOOL_CONTENT_CHARS,
			),
			isError: msg.isError === true,
			timestamp,
		});
	}
}

export function handleToolExecutionStart(sessionKey: string, toolCallId: string, toolName: string): void {
	trackPending(sessionKey, toolCallId, toolName, Date.now());
}

export function handleToolExecutionEnd(
	sessionKey: string,
	toolCallId: string,
	toolName: string,
	result: unknown,
	isError: boolean,
): ToolWatchCustomEntryData {
	const timestamp = Date.now();
	const content = extractToolExecutionContent(result);

	trackCompleted(sessionKey, { toolCallId, toolName, content, isError, timestamp });

	return { type: "tool_execution_end", toolCallId, toolName, content, isError, timestamp };
}

// --- Test helpers ---

export function _resetAllState(): void {
	toolWatchStateBySession.clear();
	activeSessionKey = undefined;
}

export function _getState(sessionKey: string): SessionToolWatchState | undefined {
	return toolWatchStateBySession.get(sessionKey);
}
