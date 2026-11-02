const words: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  ai: "AI",
  api: "API",
  tts: "TTS",
  vl: "VL",
  vlm: "VLM",
  llm: "LLM",
  moe: "MoE",
  chatgpt: "ChatGPT",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  seedance: "Seedance",
};

export function modelDisplayName(id: string) {
  return id
    .replace(
      /^(?:openai|anthropic|google|gemini|z-ai|zai|zai-org|zhipu|bigmodel|qwen|dashscope|deepseek|deepseek-ai|moonshot|moonshotai|minimax|minimaxai|mistral|mistralai|xai|x-ai|meta-llama|cohere|perplexity|stepfun)\//i,
      "",
    )
    .replace(
      /^(claude-(?:(?:opus|sonnet|haiku)-)?)(\d+)-(\d)(?=-|$)/i,
      "$1$2.$3",
    )
    .replace(/^(qwen|gemini|gemma|glm|gpt|grok|llama)(?=\d)/i, "$1 ")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (words[lower]) return words[lower];
      if (/^o\d/.test(lower) || /^\d/.test(word))
        return word.replace(
          /(\d)([bmk])$/i,
          (_, n, unit) => n + unit.toUpperCase(),
        );
      return word[0].toUpperCase() + word.slice(1);
    })
    .join(" ");
}
