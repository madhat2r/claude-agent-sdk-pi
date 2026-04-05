import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PROVIDER_ID } from "./src/types.js";
import { streamClaudeAgentSdk } from "./src/stream.js";

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
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-agent-sdk",
		apiKey: "ANTHROPIC_API_KEY",
		api: "claude-agent-sdk",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk,
	});
}
