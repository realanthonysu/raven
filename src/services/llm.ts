import type { ModelConfig } from "@/types";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export async function streamChat(
  messages: LLMMessage[],
  model: ModelConfig,
  callbacks: StreamCallbacks
): Promise<void> {
  try {
    const response = await fetch(`${model.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.api_key}`,
      },
      body: JSON.stringify({
        model: model.model_name,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          callbacks.onDone(fullText);
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            callbacks.onToken(content);
          }
        } catch {
          // Ignore parse errors for non-JSON lines
        }
      }
    }

    callbacks.onDone(fullText);
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

export function buildPrompt(
  systemPrompt: string,
  userContent: string
): LLMMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

export function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /^## (.+)\n([\s\S]*?)(?=^## |\z)/gm;
  let match;
  while ((match = regex.exec(text)) !== null) {
    sections[match[1].trim()] = match[2].trim();
  }
  return sections;
}
