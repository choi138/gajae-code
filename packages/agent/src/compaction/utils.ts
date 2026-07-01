/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message } from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import type { AgentMessage } from "../types";
import fileOperationsTemplate from "./prompts/file-operations.md" with { type: "text" };
import summarizationSystemPrompt from "./prompts/summarization-system.md" with { type: "text" };

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter(f => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
const FILE_OPERATION_SUMMARY_LIMIT = 20;

function truncateFileList(files: string[]): string[] {
	if (files.length <= FILE_OPERATION_SUMMARY_LIMIT) return files;
	const omitted = files.length - FILE_OPERATION_SUMMARY_LIMIT;
	return [...files.slice(0, FILE_OPERATION_SUMMARY_LIMIT), `… (${omitted} more files omitted)`];
}

function stripFileOperationTags(summary: string): string {
	const withoutReadFiles = summary.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "");
	const withoutModifiedFiles = withoutReadFiles.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "");
	return withoutModifiedFiles.trimEnd();
}
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	return prompt.render(fileOperationsTemplate, {
		readFiles: truncateFileList(readFiles),
		modifiedFiles: truncateFileList(modifiedFiles),
	});
}

export function upsertFileOperations(summary: string, readFiles: string[], modifiedFiles: string[]): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;
const USER_MESSAGE_MAX_CHARS = 12000;
const ASSISTANT_MESSAGE_MAX_CHARS = 12000;
const ASSISTANT_THINKING_MAX_CHARS = 8000;
const TOOL_CALL_ARGUMENTS_MAX_CHARS = 4000;
const SERIALIZED_CONVERSATION_MAX_CHARS = 120000;
const SERIALIZED_CONVERSATION_TRUNCATION_MARKER = "\n\n[... additional conversation omitted for summarization budget]";

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function truncateToMaxChars(text: string, maxChars: number, marker: string): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= marker.length) return marker.slice(0, maxChars);
	return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

function stringifyForSummary(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return "[unserializable]";
	}
}

function formatToolCallArguments(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, entry]) => `${key}=${stringifyForSummary(entry)}`)
			.join(", ");
	}
	return stringifyForSummary(value);
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	let serializedLength = 0;
	let exhausted = false;

	const appendPart = (part: string): void => {
		if (exhausted) return;
		const separatorLength = parts.length === 0 ? 0 : 2;
		const remaining = SERIALIZED_CONVERSATION_MAX_CHARS - serializedLength - separatorLength;
		if (remaining <= 0) {
			exhausted = true;
			return;
		}

		const boundedPart = truncateToMaxChars(part, remaining, SERIALIZED_CONVERSATION_TRUNCATION_MARKER);
		parts.push(boundedPart);
		serializedLength += separatorLength + boundedPart.length;
		if (boundedPart.length < part.length) exhausted = true;
	};

	for (const msg of messages) {
		if (exhausted) break;
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
			if (content) appendPart(`[User]: ${truncateForSummary(content, USER_MESSAGE_MAX_CHARS)}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const argsStr = truncateForSummary(
						formatToolCallArguments(block.arguments as unknown),
						TOOL_CALL_ARGUMENTS_MAX_CHARS,
					);
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				appendPart(
					`[Assistant thinking]: ${truncateForSummary(thinkingParts.join("\n"), ASSISTANT_THINKING_MAX_CHARS)}`,
				);
			}
			if (exhausted) break;
			if (textParts.length > 0) {
				appendPart(`[Assistant]: ${truncateForSummary(textParts.join("\n"), ASSISTANT_MESSAGE_MAX_CHARS)}`);
			}
			if (exhausted) break;
			if (toolCalls.length > 0) {
				appendPart(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			if (content) {
				appendPart(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = prompt.render(summarizationSystemPrompt);
