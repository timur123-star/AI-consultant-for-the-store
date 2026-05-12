// Обёртка над Groq SDK — взаимозаменяема с OpenAI ChatCompletions API,
// поэтому при необходимости можно перевести на любого OpenAI-совместимого провайдера,
// поменяв только client и model.
import Groq from 'groq-sdk';
import { config } from './config.js';
import type { ChatMessage } from './types.js';

const client = new Groq({ apiKey: config.groqApiKey });

export interface ChatCompleteArgs {
  system: string;
  history: ChatMessage[];
  userMessage: string;
}

export async function chatComplete({
  system,
  history,
  userMessage,
}: ChatCompleteArgs): Promise<string> {
  const messages = [
    { role: 'system' as const, content: system },
    ...history,
    { role: 'user' as const, content: userMessage },
  ];

  const completion = await client.chat.completions.create({
    model: config.groqModel,
    messages,
    temperature: 0.4,
    max_tokens: 600,
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}
