import { describe, expect, it } from "bun:test";
import { serializeConversation } from "@gajae-code/agent-core/compaction/utils";
import type { Message } from "@gajae-code/ai";

describe("serializeConversation", () => {
	it("truncates long tool results in serialized summaries", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).toContain("x".repeat(2000));
		expect(result).not.toContain("x".repeat(3000));
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("truncates long user, assistant, thinking, and tool-call argument content", () => {
		const longUserText = "u".repeat(30000);
		const longAssistantText = "a".repeat(30000);
		const longThinkingText = "t".repeat(20000);
		const longArgumentText = "p".repeat(20000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longUserText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: longThinkingText },
					{ type: "text", text: longAssistantText },
					{
						type: "toolCall",
						id: "tc1",
						name: "write",
						arguments: { path: "large.txt", content: longArgumentText },
					},
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
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
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[User]:");
		expect(result).toContain("[Assistant thinking]:");
		expect(result).toContain("[Assistant]:");
		expect(result).toContain("[Assistant tool calls]:");
		expect(result).toContain("more characters truncated");
		expect(result).not.toContain("u".repeat(13000));
		expect(result).not.toContain("a".repeat(13000));
		expect(result).not.toContain("t".repeat(9000));
		expect(result).not.toContain("p".repeat(5000));
	});

	it("bounds the total serialized conversation size", () => {
		const messages: Message[] = Array.from(
			{ length: 20 },
			(_, index): Message => ({
				role: "user",
				content: [{ type: "text", text: `message-${index}-${"z".repeat(30000)}` }],
				timestamp: Date.now(),
			}),
		);

		const result = serializeConversation(messages);

		expect(result.length).toBeLessThanOrEqual(120000);
		expect(result).toContain("additional conversation omitted for summarization budget");
	});
});
