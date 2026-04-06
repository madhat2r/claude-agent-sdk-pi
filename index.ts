import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PROVIDER_ID } from "./src/types.js";
import { streamClaudeAgentSdk } from "./src/stream.js";
import {
	type ToolWatchCustomEntryData,
	TOOL_WATCH_CUSTOM_TYPE,
	sessionKeyFromId,
	getActiveSessionKey,
	setActiveSessionKey,
	deleteSessionState,
	hydrateFromEntries,
	handleMessageEnd,
	handleToolExecutionStart,
	handleToolExecutionEnd,
} from "./src/ledger.js";

const MODELS = getModels("anthropic").map((model) => ({
	id: model.id,
	name: model.name,
	reasoning: model.reasoning,
	input: model.input,
	cost: model.cost,
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
}));

export default function (pi: ExtensionAPI) {
	// --- Tool execution ledger: session lifecycle handlers ---

	const refreshToolWatchState = (ctx: { sessionManager: { getSessionId(): string; getBranch(): unknown[] }; model?: { provider?: string } }, providerOverride?: string) => {
		const sessionKey = sessionKeyFromId(ctx.sessionManager.getSessionId());
		setActiveSessionKey(sessionKey);
		const provider = providerOverride ?? ctx.model?.provider;
		if (provider !== PROVIDER_ID) {
			deleteSessionState(sessionKey);
			return;
		}
		const entries = ctx.sessionManager.getBranch();
		hydrateFromEntries(sessionKey, entries);
	};

	pi.on("session_start", (_event, ctx) => {
		refreshToolWatchState(ctx as Parameters<typeof refreshToolWatchState>[0]);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionKey = sessionKeyFromId(ctx.sessionManager.getSessionId());
		deleteSessionState(sessionKey);
		if (getActiveSessionKey() === sessionKey) {
			setActiveSessionKey(undefined);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== PROVIDER_ID) return;
		refreshToolWatchState(
			ctx as Parameters<typeof refreshToolWatchState>[0],
			event.model.provider,
		);
	});

	// --- Tool execution ledger: message & tool tracking ---

	pi.on("message_end", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		const sessionKey = sessionKeyFromId(ctx.sessionManager.getSessionId());
		setActiveSessionKey(sessionKey);
		handleMessageEnd(sessionKey, event.message);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		const sessionKey = sessionKeyFromId(ctx.sessionManager.getSessionId());
		setActiveSessionKey(sessionKey);
		handleToolExecutionStart(sessionKey, event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		const sessionKey = sessionKeyFromId(ctx.sessionManager.getSessionId());
		setActiveSessionKey(sessionKey);
		const entryData = handleToolExecutionEnd(
			sessionKey,
			event.toolCallId,
			event.toolName,
			event.result,
			event.isError,
		);
		pi.appendEntry<ToolWatchCustomEntryData>(TOOL_WATCH_CUSTOM_TYPE, entryData);
	});

	// --- Provider registration ---

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-agent-sdk",
		apiKey: "ANTHROPIC_API_KEY",
		api: "claude-agent-sdk",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk,
	});
}
