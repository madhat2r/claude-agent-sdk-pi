import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "os";
import { join } from "path";

export const PROVIDER_ID = "claude-agent-sdk";

export const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
};

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	glob: "Glob",
};

export const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];
export const BUILTIN_TOOL_NAMES = new Set(Object.keys(PI_TO_SDK_TOOL_NAME));
export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
export const SKILLS_ALIAS_PROJECT = ".claude/skills";
export const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
export const PROJECT_SKILLS_ROOT = join(process.cwd(), ".pi", "skills");
export const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
export const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

export type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
export type NonXhighThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

export type ProviderSettings = {
	appendSystemPrompt?: boolean;
	/**
	 * Controls which filesystem-based configuration sources the SDK loads settings from
	 * (maps to Claude Code CLI --setting-sources).
	 *
	 * - "user"    => ~/.claude (or CLAUDE_CONFIG_DIR)
	 * - "project" => .claude in the current repo
	 * - "local"   => .claude/settings.local.json in the current repo
	 */
	settingSources?: SettingSource[];
	/**
	 * When true, pass Claude Code CLI --strict-mcp-config to ignore MCP servers
	 * from ~/.claude.json and project .mcp.json files. This prevents Claude Code
	 * from auto-injecting large MCP tool schemas (a major token cost) when
	 * appendSystemPrompt=false.
	 */
	strictMcpConfig?: boolean;
};
