import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODEL = "claude-sonnet-4-20250514";
export const MCP_BETA = "mcp-client-2025-04-04";
export const HUBSPOT_OWNER_ID = "32225666";

export interface MCPServer {
  type: "url";
  url: string;
  name: string;
  authorization_token?: string;
}

export function hubspotServer(): MCPServer {
  return {
    type: "url",
    url: "https://mcp.hubspot.com/anthropic",
    name: "hubspot",
    ...(process.env.HUBSPOT_ACCESS_TOKEN && {
      authorization_token: process.env.HUBSPOT_ACCESS_TOKEN,
    }),
  };
}

export function gmailServer(): MCPServer {
  return {
    type: "url",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    name: "gmail",
    ...(process.env.GOOGLE_OAUTH_TOKEN && {
      authorization_token: `Bearer ${process.env.GOOGLE_OAUTH_TOKEN}`,
    }),
  };
}

export function calendarServer(): MCPServer {
  return {
    type: "url",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    name: "calendar",
    ...(process.env.GOOGLE_OAUTH_TOKEN && {
      authorization_token: `Bearer ${process.env.GOOGLE_OAUTH_TOKEN}`,
    }),
  };
}

export function cssaServer(): MCPServer {
  return {
    type: "url",
    url: "https://computed-success-analysis-mcp-production.up.railway.app/sse",
    name: "cssa",
    ...(process.env.CSSA_API_KEY && {
      authorization_token: process.env.CSSA_API_KEY,
    }),
  };
}

export async function runAgentLoop(
  system: string,
  userMessage: string,
  servers: MCPServer[],
  maxTokens = 8096
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 30;

  while (iterations < MAX_ITERATIONS) {
    const response = await (anthropic.beta.messages as any).create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
      mcp_servers: servers,
      betas: [MCP_BETA],
    });

    const stopReason = response.stop_reason;

    if (stopReason === "end_turn") {
      return response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    }

    if (stopReason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults = response.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({
          type: "tool_result" as const,
          tool_use_id: b.id,
          content: "executed",
        }));

      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }
    } else {
      // Unknown stop reason — return what we have
      return response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    }

    iterations++;
  }

  throw new Error("Agent loop exceeded max iterations");
}

export function extractJSON<T>(text: string): T {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ||
    text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error("No JSON found in response");
  return JSON.parse(jsonMatch[1]) as T;
}
