import { existsSync, readFileSync } from "fs";
import { dirname, relative, resolve, join } from "path";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderSettings } from "./types.js";
import {
	GLOBAL_AGENTS_PATH,
	GLOBAL_SETTINGS_PATH,
	PROJECT_SETTINGS_PATH,
	SKILLS_ALIAS_GLOBAL,
	SKILLS_ALIAS_PROJECT,
	GLOBAL_SKILLS_ROOT,
	PROJECT_SKILLS_ROOT,
} from "./types.js";

/** Load provider settings, merging global then project (project wins). */
export function loadProviderSettings(): ProviderSettings {
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const projectSettings = readSettingsFile(PROJECT_SETTINGS_PATH);
	return { ...globalSettings, ...projectSettings };
}

/**
 * Read and parse a settings file, returning the provider-specific block.
 *
 * Accepts the canonical key `claudeAgentSdkProvider`, plus legacy aliases
 * `claude-agent-sdk-provider` and `claudeAgentSdk` for backwards compatibility.
 */
export function readSettingsFile(filePath: string): ProviderSettings {
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const settingsBlock =
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};

		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean"
				? settingsBlock["appendSystemPrompt"]
				: undefined;

		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every(
				(value: unknown) =>
					typeof value === "string" && (value === "user" || value === "project" || value === "local"),
			)
				? (settingSourcesRaw as SettingSource[])
				: undefined;

		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;

		return { appendSystemPrompt, settingSources, strictMcpConfig };
	} catch {
		return {};
	}
}

/** Extract the skills block from Pi's system prompt and rewrite paths for the SDK. */
export function extractSkillsAppend(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const startIndex = systemPrompt.indexOf(startMarker);
	if (startIndex === -1) return undefined;
	const endIndex = systemPrompt.indexOf(endMarker, startIndex);
	if (endIndex === -1) return undefined;
	const skillsBlock = systemPrompt.slice(startIndex, endIndex + endMarker.length).trim();
	return rewriteSkillsLocations(skillsBlock);
}

/** Rewrite <location> tags to use skill alias paths. */
export function rewriteSkillsLocations(skillsBlock: string): string {
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match: string, location: string) => {
		let rewritten = location;
		if (location.startsWith(GLOBAL_SKILLS_ROOT)) {
			const relPath = relative(GLOBAL_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_GLOBAL}/${relPath}`.replace(/\/\/+/g, "/");
		} else if (location.startsWith(PROJECT_SKILLS_ROOT)) {
			const relPath = relative(PROJECT_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_PROJECT}/${relPath}`.replace(/\/\/+/g, "/");
		}
		return `<location>${rewritten}</location>`;
	});
}

/** Find AGENTS.md in parent directories, falling back to global. */
export function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
	return undefined;
}

/** Walk up from startDir looking for AGENTS.md. */
export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

/** Read AGENTS.md and sanitize its content for the SDK system prompt. */
export function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Rewrite Pi-specific paths in AGENTS.md content for Claude Code compatibility.
 *
 * Converts `.pi` directory references to `.claude` equivalents. Only targets
 * path-like patterns to avoid corrupting unrelated content.
 */
export function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	// Rewrite path references: ~/.pi → ~/.claude, .pi → .claude
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\b/g, "$1.claude");
	return sanitized;
}
