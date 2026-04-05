import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ThinkingLevel, NonXhighThinkingLevel } from "./types.js";

const DEFAULT_THINKING_BUDGETS: Record<NonXhighThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 31999,
};

// NOTE: "xhigh" is unavailable in the TUI because pi-ai's supportsXhigh()
// doesn't recognize the "claude-agent-sdk" api type. As a workaround, opus-4-6
// gets shifted budgets so "high" uses the budget that xhigh would normally use.
const OPUS_46_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 31999,
	high: 63999,
	// Future-proofing: pi currently won't surface "xhigh" for this provider because
	// pi-ai's supportsXhigh() doesn't recognize the "claude-agent-sdk" api type.
	// If/when that changes, we can shift the budgets to 2048, 8192, 16384, 31999, 63999.
	xhigh: 63999,
};

export function mapThinkingTokens(
	reasoning?: ThinkingLevel,
	modelId?: string,
	thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): number | undefined {
	if (!reasoning) return undefined;

	const isOpus46 = modelId?.includes("opus-4-6") || modelId?.includes("opus-4.6");
	if (isOpus46) {
		return OPUS_46_THINKING_BUDGETS[reasoning];
	}

	const effectiveReasoning: NonXhighThinkingLevel = reasoning === "xhigh" ? "high" : reasoning;

	const customBudgets = thinkingBudgets as Partial<Record<NonXhighThinkingLevel, number>> | undefined;
	const customBudget = customBudgets?.[effectiveReasoning];
	if (typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0) {
		return customBudget;
	}

	return DEFAULT_THINKING_BUDGETS[effectiveReasoning];
}
