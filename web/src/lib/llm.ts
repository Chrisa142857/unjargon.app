export function serverCanLLM(): boolean {
  return process.env.UNJARGON_FAKE_TRANSLATOR === "1" || !!process.env.ANTHROPIC_API_KEY;
}
