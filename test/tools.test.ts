import { describe, it, expect } from "vitest";
import { mapToolName, mapPiToolNameToSdk, mapToolArgs, resolveSdkTools, rewriteSkillAliasPath } from "../src/tools.js";
import { MCP_TOOL_PREFIX } from "../src/types.js";

describe("mapToolName", () => {
	it("maps builtin SDK names to Pi names", () => {
		expect(mapToolName("read")).toBe("read");
		expect(mapToolName("write")).toBe("write");
		expect(mapToolName("edit")).toBe("edit");
		expect(mapToolName("bash")).toBe("bash");
		expect(mapToolName("grep")).toBe("grep");
		expect(mapToolName("glob")).toBe("find");
	});

	it("is case-insensitive for builtins", () => {
		expect(mapToolName("Read")).toBe("read");
		expect(mapToolName("BASH")).toBe("bash");
	});

	it("uses custom map when provided", () => {
		const custom = new Map([["mcp__custom-tools__MyTool", "my_tool"]]);
		expect(mapToolName("mcp__custom-tools__MyTool", custom)).toBe("my_tool");
	});

	it("strips MCP prefix for unknown tools", () => {
		expect(mapToolName(`${MCP_TOOL_PREFIX}SomeTool`)).toBe("SomeTool");
	});

	it("returns name as-is for unknown non-MCP tools", () => {
		expect(mapToolName("unknown_tool")).toBe("unknown_tool");
	});
});

describe("mapPiToolNameToSdk", () => {
	it("maps Pi names to SDK names", () => {
		expect(mapPiToolNameToSdk("read")).toBe("Read");
		expect(mapPiToolNameToSdk("write")).toBe("Write");
		expect(mapPiToolNameToSdk("find")).toBe("Glob");
		expect(mapPiToolNameToSdk("glob")).toBe("Glob");
	});

	it("returns empty string for undefined/empty name", () => {
		expect(mapPiToolNameToSdk()).toBe("");
		expect(mapPiToolNameToSdk("")).toBe("");
	});

	it("uses custom map when provided", () => {
		const custom = new Map([["my_tool", "mcp__custom-tools__my_tool"]]);
		expect(mapPiToolNameToSdk("my_tool", custom)).toBe("mcp__custom-tools__my_tool");
	});

	it("PascalCases unknown tool names", () => {
		expect(mapPiToolNameToSdk("some_custom_tool")).toBe("SomeCustomTool");
	});
});

describe("mapToolArgs", () => {
	it("maps read tool arguments", () => {
		const result = mapToolArgs("read", { file_path: "/foo/bar", offset: 10, limit: 20 }, false);
		expect(result).toEqual({ path: "/foo/bar", offset: 10, limit: 20 });
	});

	it("maps write tool arguments", () => {
		const result = mapToolArgs("write", { file_path: "/foo", content: "hello" }, false);
		expect(result).toEqual({ path: "/foo", content: "hello" });
	});

	it("maps edit tool arguments with old_string/new_string", () => {
		const result = mapToolArgs("edit", { file_path: "/f", old_string: "a", new_string: "b" }, false);
		expect(result).toEqual({ path: "/f", oldText: "a", newText: "b" });
	});

	it("maps edit tool arguments with oldText/newText", () => {
		const result = mapToolArgs("edit", { file_path: "/f", oldText: "a", newText: "b" }, false);
		expect(result).toEqual({ path: "/f", oldText: "a", newText: "b" });
	});

	it("maps bash tool arguments", () => {
		const result = mapToolArgs("bash", { command: "ls -la", timeout: 5000 }, false);
		expect(result).toEqual({ command: "ls -la", timeout: 5000 });
	});

	it("maps grep tool arguments with head_limit", () => {
		const result = mapToolArgs("grep", { pattern: "foo", path: "/bar", head_limit: 100 }, false);
		expect(result).toEqual({ pattern: "foo", path: "/bar", glob: undefined, limit: 100 });
	});

	it("maps find tool arguments", () => {
		const result = mapToolArgs("find", { pattern: "*.ts", path: "/src" }, false);
		expect(result).toEqual({ pattern: "*.ts", path: "/src" });
	});

	it("passes unknown tool args through unchanged", () => {
		const args = { foo: "bar", baz: 42 };
		expect(mapToolArgs("custom_tool", args, false)).toBe(args);
	});

	it("returns empty object for undefined args", () => {
		expect(mapToolArgs("bash", undefined, false)).toEqual({ command: undefined, timeout: undefined });
	});
});

describe("resolveSdkTools", () => {
	it("returns default tools when no tools in context", () => {
		const result = resolveSdkTools({ messages: [], tools: undefined });
		expect(result.sdkTools).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
		expect(result.customTools).toEqual([]);
	});

	it("maps builtin tools", () => {
		const result = resolveSdkTools({
			messages: [],
			tools: [
				{ name: "read", description: "Read a file", parameters: {} },
				{ name: "bash", description: "Run bash", parameters: {} },
			] as any,
		});
		expect(result.sdkTools).toContain("Read");
		expect(result.sdkTools).toContain("Bash");
		expect(result.customTools).toEqual([]);
	});

	it("identifies custom tools", () => {
		const result = resolveSdkTools({
			messages: [],
			tools: [
				{ name: "read", description: "Read a file", parameters: {} },
				{ name: "MyCustomTool", description: "Custom", parameters: {} },
			] as any,
		});
		expect(result.sdkTools).toContain("Read");
		expect(result.customTools).toHaveLength(1);
		expect(result.customTools[0].name).toBe("MyCustomTool");
		expect(result.customToolNameToSdk.get("MyCustomTool")).toBe("mcp__custom-tools__MyCustomTool");
		expect(result.customToolNameToPi.get("mcp__custom-tools__MyCustomTool")).toBe("MyCustomTool");
	});
});

describe("rewriteSkillAliasPath", () => {
	it("returns non-string values unchanged", () => {
		expect(rewriteSkillAliasPath(42)).toBe(42);
		expect(rewriteSkillAliasPath(null)).toBe(null);
	});

	it("returns unrelated paths unchanged", () => {
		expect(rewriteSkillAliasPath("/some/random/path")).toBe("/some/random/path");
	});

	it("rewrites global skill alias paths", () => {
		const result = rewriteSkillAliasPath("~/.claude/skills/my-skill.md");
		expect(result).toBe("~/.pi/agent/skills/my-skill.md");
	});
});
