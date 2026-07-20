export function serverCanLLM(): boolean {
  return process.env.UNJARGON_FAKE_TRANSLATOR === "1" ||
    (process.env.UNJARGON_ALLOW_SERVER_AI === "1" && !!process.env.ANTHROPIC_API_KEY);
}
