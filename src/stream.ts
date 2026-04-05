import {
	calculateCost,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { query, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { parsePartialJson } from "./utils.js";
import { mapToolName, mapToolArgs, resolveSdkTools, buildCustomToolServers } from "./tools.js";
import { loadProviderSettings, extractAgentsAppend, extractSkillsAppend } from "./settings.js";
import { mapThinkingTokens } from "./thinking.js";
import { buildPromptBlocks, buildPromptStream } from "./prompt.js";
import { TOOL_EXECUTION_DENIED_MESSAGE } from "./types.js";

/** Patterns that identify transient/retryable errors. */
const RETRYABLE_PATTERN =
	/overloaded|rate[_\s]?limit|429|too many requests|5[0-9]{2}|service[_\s]?unavailable|connection[_\s]?(refused|reset)|ECONNR|fetch failed|ETIMEDOUT/i;

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "refusal":
		case "sensitive":
			return "stop";
		default:
			if (reason) {
				console.warn(`[claude-agent-sdk] Unknown stop reason: ${reason}`);
			}
			return "stop";
	}
}

function isRetryableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return RETRYABLE_PATTERN.test(message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function streamClaudeAgentSdk(
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let sdkQuery: ReturnType<typeof query> | undefined;
		let wasAborted = false;
		const requestAbort = () => {
			if (!sdkQuery) return;
			void sdkQuery.interrupt().catch(() => {
				try {
					sdkQuery?.close();
				} catch {
					// ignore shutdown errors
				}
			});
		};
		const onAbort = () => {
			wasAborted = true;
			requestAbort();
		};
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const blocks = output.content as Array<
			| { type: "text"; text: string; index: number }
			| { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; index: number }
			| {
					type: "toolCall";
					id: string;
					name: string;
					arguments: Record<string, unknown>;
					partialJson: string;
					index: number;
			  }
		>;

		let started = false;
		let sawStreamEvent = false;
		let sawToolCall = false;
		let shouldStopEarly = false;

		try {
			const { sdkTools, customTools, customToolNameToSdk, customToolNameToPi } = resolveSdkTools(context);
			const promptBlocks = buildPromptBlocks(context, customToolNameToSdk);

			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();

			const mcpServers = buildCustomToolServers(customTools);
			const providerSettings = loadProviderSettings();
			const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
			const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
			const skillsAppend = appendSystemPrompt ? extractSkillsAppend(context.systemPrompt) : undefined;
			const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
			const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			const allowSkillAliasRewrite = Boolean(skillsAppend);

			const settingSources: SettingSource[] | undefined = appendSystemPrompt
				? undefined
				: providerSettings.settingSources ?? ["user", "project"];

			const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;
			const extraArgs = strictMcpConfigEnabled ? { "strict-mcp-config": null } : undefined;

			const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
				cwd,
				model: model.id,
				tools: sdkTools,
				permissionMode: "dontAsk",
				includePartialMessages: true,
				canUseTool: async () => ({
					behavior: "deny" as const,
					message: TOOL_EXECUTION_DENIED_MESSAGE,
				}),
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: systemPromptAppend ? systemPromptAppend : undefined,
				},
				...(settingSources ? { settingSources } : {}),
				...(extraArgs ? { extraArgs } : {}),
				...(mcpServers ? { mcpServers } : {}),
			};

			const maxThinkingTokens = mapThinkingTokens(options?.reasoning, model.id, options?.thinkingBudgets);
			if (maxThinkingTokens != null) {
				queryOptions.maxThinkingTokens = maxThinkingTokens;
			}

			/** Process a single SDK message, updating output and pushing stream events. */
			function processMessage(message: SDKMessage): void {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}

				switch (message.type) {
					case "stream_event": {
						sawStreamEvent = true;
						const event = (message as SDKMessage & { event: Record<string, unknown> }).event;
						if (!event) break;

						const eventType = event.type as string;

						if (eventType === "message_start") {
							const msg = event.message as Record<string, unknown> | undefined;
							if (msg) {
								// Capture responseId
								if (typeof msg.id === "string") {
									output.responseId = msg.id;
								}
								const usage = msg.usage as Record<string, number> | undefined;
								if (usage) {
									output.usage.input = usage.input_tokens ?? 0;
									output.usage.output = usage.output_tokens ?? 0;
									output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
									output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
									output.usage.totalTokens =
										output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
									calculateCost(model, output.usage);
								}
							}
							break;
						}

						if (eventType === "content_block_start") {
							const contentBlock = event.content_block as Record<string, unknown> | undefined;
							const blockIndex = event.index as number;
							if (!contentBlock) break;

							const blockType = contentBlock.type as string;

							if (blockType === "text") {
								const block = { type: "text" as const, text: "", index: blockIndex };
								output.content.push(block);
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							} else if (blockType === "thinking") {
								const block = {
									type: "thinking" as const,
									thinking: "",
									thinkingSignature: "",
									index: blockIndex,
								};
								output.content.push(block);
								stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
							} else if (blockType === "redacted_thinking") {
								// Handle redacted thinking — preserve the encrypted signature
								// for multi-turn continuity
								const block = {
									type: "thinking" as const,
									thinking: "[Reasoning redacted]",
									thinkingSignature: (contentBlock.data as string) ?? "",
									redacted: true,
									index: blockIndex,
								};
								output.content.push(block);
								const idx = output.content.length - 1;
								stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
								// Emit end immediately since redacted blocks have no deltas
								const cleanBlock = {
									type: "thinking" as const,
									thinking: "[Reasoning redacted]",
									thinkingSignature: block.thinkingSignature,
									redacted: true,
								};
								output.content[idx] = cleanBlock;
								stream.push({
									type: "thinking_end",
									contentIndex: idx,
									content: "[Reasoning redacted]",
									partial: output,
								});
							} else if (blockType === "tool_use") {
								sawToolCall = true;
								const block = {
									type: "toolCall" as const,
									id: contentBlock.id as string,
									name: mapToolName(contentBlock.name as string, customToolNameToPi),
									arguments: (contentBlock.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: blockIndex,
								};
								output.content.push(block);
								stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
							}
							break;
						}

						if (eventType === "content_block_delta") {
							const delta = event.delta as Record<string, unknown> | undefined;
							const blockIndex = event.index as number;
							if (!delta) break;

							const deltaType = delta.type as string;

							if (deltaType === "text_delta") {
								const index = blocks.findIndex((block) => block.index === blockIndex);
								const block = blocks[index];
								if (block?.type === "text") {
									block.text += delta.text as string;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: delta.text as string,
										partial: output,
									});
								}
							} else if (deltaType === "thinking_delta") {
								const index = blocks.findIndex((block) => block.index === blockIndex);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinking += delta.thinking as string;
									stream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: delta.thinking as string,
										partial: output,
									});
								}
							} else if (deltaType === "input_json_delta") {
								const index = blocks.findIndex((block) => block.index === blockIndex);
								const block = blocks[index];
								if (block?.type === "toolCall") {
									block.partialJson += delta.partial_json as string;
									block.arguments = parsePartialJson(block.partialJson, block.arguments);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: delta.partial_json as string,
										partial: output,
									});
								}
							} else if (deltaType === "signature_delta") {
								const index = blocks.findIndex((block) => block.index === blockIndex);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature as string);
								}
							}
							break;
						}

						if (eventType === "content_block_stop") {
							const blockIndex = event.index as number;
							const index = blocks.findIndex((block) => block.index === blockIndex);
							const block = blocks[index];
							if (!block) break;

							if (block.type === "text") {
								const cleanBlock = { type: "text" as const, text: block.text };
								output.content[index] = cleanBlock;
								stream.push({
									type: "text_end",
									contentIndex: index,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								const cleanBlock = {
									type: "thinking" as const,
									thinking: block.thinking,
									thinkingSignature: block.thinkingSignature,
								};
								output.content[index] = cleanBlock;
								stream.push({
									type: "thinking_end",
									contentIndex: index,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								sawToolCall = true;
								const cleanBlock = {
									type: "toolCall" as const,
									id: block.id,
									name: block.name,
									arguments: mapToolArgs(
										block.name,
										parsePartialJson(block.partialJson, block.arguments),
										allowSkillAliasRewrite,
									),
								};
								output.content[index] = cleanBlock;
								stream.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: cleanBlock,
									partial: output,
								});
							}
							break;
						}

						if (eventType === "message_delta") {
							const delta = event.delta as Record<string, unknown> | undefined;
							output.stopReason = mapStopReason(delta?.stop_reason as string | undefined);
							const usage = event.usage as Record<string, number> | undefined;
							if (usage) {
								if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
								if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
								if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
								if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
								output.usage.totalTokens =
									output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
								calculateCost(model, output.usage);
							}
							break;
						}

						if (eventType === "message_stop" && sawToolCall) {
							output.stopReason = "toolUse";
							shouldStopEarly = true;
							break;
						}

						break;
					}

					case "result": {
						const resultMessage = message as SDKMessage & { subtype?: string; result?: string };
						if (!sawStreamEvent && resultMessage.subtype === "success") {
							output.content.push({ type: "text", text: resultMessage.result || "" });
						}
						break;
					}
				}
			}

			// Retry loop: retry only if we haven't started streaming events to the consumer
			let lastError: unknown;
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (wasAborted || options?.signal?.aborted) break;

				if (attempt > 0) {
					console.warn(
						`[claude-agent-sdk] Retrying after transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
					);
					try {
						await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1), options?.signal);
					} catch {
						break; // aborted during sleep
					}
				}

				try {
					const prompt = buildPromptStream(promptBlocks);
					sdkQuery = query({ prompt, options: queryOptions });

					if (wasAborted) {
						requestAbort();
						break;
					}

					for await (const message of sdkQuery) {
						processMessage(message);
						if (shouldStopEarly) break;
					}

					// Success — clear last error and break out of retry loop
					lastError = undefined;
					break;
				} catch (error) {
					lastError = error;

					// If we already started streaming, we can't retry — the consumer
					// has already received partial data
					if (started) break;

					// Only retry transient errors
					if (!isRetryableError(error)) break;

					// Clean up the failed query
					try {
						sdkQuery?.close();
					} catch {
						// ignore
					}
					sdkQuery = undefined;
				}
			}

			if (lastError) {
				throw lastError;
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}

			stream.push({
				type: "done",
				reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		} finally {
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			sdkQuery?.close();
		}
	})();

	return stream;
}
