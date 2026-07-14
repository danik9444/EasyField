export interface ChatModelDef {
  family: 'anthropic' | 'openai' | 'responses'
  model: string
  /** Base route before `/v1/...` on Kie's provider-compatible API. */
  path?: string
  /** Kie's documented Responses reasoning enum. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
}

// Display name (models.ts) → Kie's exact provider-compatible route + model ID.
export const CHAT_MODELS: Record<string, ChatModelDef> = {
  'Fable 5': { family: 'anthropic', model: 'claude-fable-5' },
  'Opus 4.8': { family: 'anthropic', model: 'claude-opus-4-8' },
  'Sonnet 5': { family: 'anthropic', model: 'claude-sonnet-5' },
  'GPT 5.6 Sol': { family: 'responses', model: 'gpt-5-6-sol', path: 'codex', reasoningEffort: 'high' },
  'GPT 5.6 Terra': { family: 'responses', model: 'gpt-5-6-terra', path: 'codex', reasoningEffort: 'medium' },
  'GPT 5.6 Luna': { family: 'responses', model: 'gpt-5-6-luna', path: 'codex', reasoningEffort: 'low' },
  'Grok 4.5': { family: 'responses', model: 'grok-4-5', path: 'grok', reasoningEffort: 'high' },
  'Grok 4.3': { family: 'responses', model: 'grok-4-3', path: 'grok', reasoningEffort: 'medium' },
  'Haiku 4.5': { family: 'anthropic', model: 'claude-haiku-4-5' },
  'GPT 5.5': { family: 'responses', model: 'gpt-5-5', path: 'codex', reasoningEffort: 'medium' },
  'Gemini 3.1 Pro': { family: 'openai', model: 'gemini-3.1-pro', path: 'gemini-3.1-pro' },
  'Gemini 3.5 Flash': { family: 'openai', model: 'gemini-3-5-flash-openai', path: 'gemini-3-5-flash-openai' },
}
