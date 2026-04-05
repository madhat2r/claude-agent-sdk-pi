import type { Context, ImageContent } from "@mariozechner/pi-ai";
import type { ContentBlockParam, Base64ImageSource, MessageParam } from "@anthropic-ai/sdk/resources";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeSurrogates } from "./utils.js";
import { mapPiToolNameToSdk } from "./tools.js";

/**
 * Build the prompt content blocks from the conversation context.
 *
 * Filters out errored/aborted assistant messages (they contain incomplete
 * content that can confuse the model) and inserts "[No result provided]"
 * for orphaned tool calls (tool calls without a matching tool result).
 */
export function buildPromptBlocks(
	context: Context,
	customToolNameToSdk: Map<string, string> | undefined,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];

	const pushText = (text: string) => {
		blocks.push({ type: "text", text: sanitizeSurrogates(text) });
	};

	const pushImage = (image: ImageContent) => {
		blocks.push({
			type: "image",
			source: {
				type: "base64",
				media_type: image.mimeType as Base64ImageSource["media_type"],
				data: image.data,
			},
		});
	};

	const pushPrefix = (label: string) => {
		const prefix = `${blocks.length ? "\n\n" : ""}${label}\n`;
		pushText(prefix);
	};

	const appendContentBlocks = (
		content:
			| string
			| Array<{
					type: string;
					text?: string;
					data?: string;
					mimeType?: string;
			  }>,
	): boolean => {
		if (typeof content === "string") {
			if (content.length > 0) {
				pushText(content);
				return content.trim().length > 0;
			}
			return false;
		}
		if (!Array.isArray(content)) return false;
		let hasText = false;
		for (const block of content) {
			if (block.type === "text") {
				const text = block.text ?? "";
				if (text.trim().length > 0) hasText = true;
				pushText(text);
				continue;
			}
			if (block.type === "image") {
				pushImage(block as ImageContent);
				continue;
			}
			pushText(`[${block.type}]`);
		}
		return hasText;
	};

	// Track pending tool call IDs to detect orphaned tool calls
	let pendingToolCallIds: Set<string> = new Set();

	for (const message of context.messages) {
		if (message.role === "user") {
			// Flush any orphaned tool calls before user messages
			if (pendingToolCallIds.size > 0) {
				for (const id of pendingToolCallIds) {
					pushPrefix(`TOOL RESULT (historical, no result provided):`);
					pushText(`Tool call ${id} received no result.`);
				}
				pendingToolCallIds = new Set();
			}

			pushPrefix("USER:");
			const hasText = appendContentBlocks(message.content);
			if (!hasText) {
				pushText("(see attached image)");
			}
			continue;
		}

		if (message.role === "assistant") {
			// Filter out errored/aborted assistant messages — they contain incomplete
			// content (partial reasoning, broken tool calls) that can confuse the model.
			const assistantMsg = message as { stopReason?: string };
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Flush orphaned tool calls before next assistant message
			if (pendingToolCallIds.size > 0) {
				for (const id of pendingToolCallIds) {
					pushPrefix(`TOOL RESULT (historical, no result provided):`);
					pushText(`Tool call ${id} received no result.`);
				}
				pendingToolCallIds = new Set();
			}

			pushPrefix("ASSISTANT:");
			const text = contentToText(message.content, customToolNameToSdk);
			if (text.length > 0) {
				pushText(text);
			}

			// Track tool call IDs from this assistant message
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					const b = block as { type: string; id?: string };
					if (b.type === "toolCall" && b.id) {
						pendingToolCallIds.add(b.id);
					}
				}
			}
			continue;
		}

		if (message.role === "toolResult") {
			// Remove from pending — this tool call has a result
			const toolResultMsg = message as { toolCallId?: string };
			if (toolResultMsg.toolCallId) {
				pendingToolCallIds.delete(toolResultMsg.toolCallId);
			}

			const header = `TOOL RESULT (historical ${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}):`;
			pushPrefix(header);
			const hasText = appendContentBlocks(message.content);
			if (!hasText) {
				pushText("(see attached image)");
			}
		}
	}

	// Flush any remaining orphaned tool calls at the end
	if (pendingToolCallIds.size > 0) {
		for (const id of pendingToolCallIds) {
			pushPrefix(`TOOL RESULT (historical, no result provided):`);
			pushText(`Tool call ${id} received no result.`);
		}
	}

	if (!blocks.length) return [{ type: "text", text: "" }];

	return blocks;
}

/** Wrap prompt blocks into an async iterable of SDK user messages. */
export function buildPromptStream(promptBlocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	async function* generator() {
		const message: SDKUserMessage = {
			type: "user",
			message: {
				role: "user",
				content: promptBlocks,
			} as MessageParam,
			parent_tool_use_id: null,
			session_id: "prompt",
		};

		yield message;
	}

	return generator();
}

/** Convert assistant message content to a text representation. */
export function contentToText(
	content:
		| string
		| Array<{
				type: string;
				text?: string;
				thinking?: string;
				name?: string;
				arguments?: Record<string, unknown>;
		  }>,
	customToolNameToSdk?: Map<string, string>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return sanitizeSurrogates(block.text ?? "");
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments ? JSON.stringify(block.arguments) : "{}";
				const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
				return `Historical tool call (non-executable): ${toolName} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}
