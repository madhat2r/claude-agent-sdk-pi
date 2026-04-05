import type { Tool } from "@mariozechner/pi-ai";
import type { Context } from "@mariozechner/pi-ai";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { pascalCase } from "change-case";
import {
	BUILTIN_TOOL_NAMES,
	DEFAULT_TOOLS,
	MCP_SERVER_NAME,
	MCP_TOOL_PREFIX,
	PI_TO_SDK_TOOL_NAME,
	SDK_TO_PI_TOOL_NAME,
	SKILLS_ALIAS_GLOBAL,
	SKILLS_ALIAS_PROJECT,
	GLOBAL_SKILLS_ROOT,
	PROJECT_SKILLS_ROOT,
	TOOL_EXECUTION_DENIED_MESSAGE,
} from "./types.js";
import { join } from "path";

/** Map an SDK tool name back to the Pi tool name. */
export function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		return name.slice(MCP_TOOL_PREFIX.length);
	}
	return name;
}

/** Map a Pi tool name to the corresponding SDK tool name. */
export function mapPiToolNameToSdk(name?: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

/** Rewrite skill alias paths back to real filesystem paths. */
export function rewriteSkillAliasPath(pathValue: unknown): unknown {
	if (typeof pathValue !== "string") return pathValue;
	if (pathValue.startsWith(SKILLS_ALIAS_GLOBAL)) {
		return pathValue.replace(SKILLS_ALIAS_GLOBAL, "~/.pi/agent/skills");
	}
	if (pathValue.startsWith(`./${SKILLS_ALIAS_PROJECT}`)) {
		return pathValue.replace(`./${SKILLS_ALIAS_PROJECT}`, PROJECT_SKILLS_ROOT);
	}
	if (pathValue.startsWith(SKILLS_ALIAS_PROJECT)) {
		return pathValue.replace(SKILLS_ALIAS_PROJECT, PROJECT_SKILLS_ROOT);
	}
	const projectAliasAbs = join(process.cwd(), SKILLS_ALIAS_PROJECT);
	if (pathValue.startsWith(projectAliasAbs)) {
		return pathValue.replace(projectAliasAbs, PROJECT_SKILLS_ROOT);
	}
	return pathValue;
}

/** Map SDK tool arguments to Pi's expected parameter names. */
export function mapToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
	allowSkillAliasRewrite = true,
): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	const input = args ?? {};
	const resolvePath = (value: unknown) => (allowSkillAliasRewrite ? rewriteSkillAliasPath(value) : value);

	switch (normalized) {
		case "read":
			return {
				path: resolvePath(input.file_path ?? input.path),
				offset: input.offset,
				limit: input.limit,
			};
		case "write":
			return {
				path: resolvePath(input.file_path ?? input.path),
				content: input.content,
			};
		case "edit":
			return {
				path: resolvePath(input.file_path ?? input.path),
				oldText: input.old_string ?? input.oldText ?? input.old_text,
				newText: input.new_string ?? input.newText ?? input.new_text,
			};
		case "bash":
			return {
				command: input.command,
				timeout: input.timeout,
			};
		case "grep":
			return {
				pattern: input.pattern,
				path: resolvePath(input.path),
				glob: input.glob,
				limit: input.head_limit ?? input.limit,
			};
		case "find":
			return {
				pattern: input.pattern,
				path: resolvePath(input.path),
			};
		default:
			return input;
	}
}

/** Resolve which tools to expose to the SDK and which are custom (MCP-wrapped). */
export function resolveSdkTools(context: Context): {
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	if (!context.tools) {
		return {
			sdkTools: [...DEFAULT_TOOLS],
			customTools: [],
			customToolNameToSdk: new Map(),
			customToolNameToPi: new Map(),
		};
	}

	const sdkTools = new Set<string>();
	const customTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	for (const tool of context.tools) {
		const normalized = tool.name.toLowerCase();
		if (BUILTIN_TOOL_NAMES.has(normalized)) {
			const sdkName = PI_TO_SDK_TOOL_NAME[normalized];
			if (sdkName) sdkTools.add(sdkName);
			continue;
		}
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(normalized, sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { sdkTools: Array.from(sdkTools), customTools, customToolNameToSdk, customToolNameToPi };
}

/** Build MCP server definitions for custom (non-builtin) tools. */
export function buildCustomToolServers(customTools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!customTools.length) return undefined;

	const mcpTools = customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as unknown,
		handler: async () => ({
			content: [{ type: "text" as const, text: TOOL_EXECUTION_DENIED_MESSAGE }],
			isError: true,
		}),
	}));

	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		tools: mcpTools,
	});

	return { [MCP_SERVER_NAME]: server };
}
