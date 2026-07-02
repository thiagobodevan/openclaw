// Feishu broadcast sessions preserve the source route while selecting one
// configured service agent as the session owner.
export function buildFeishuBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  return baseSessionKey.startsWith(prefix)
    ? `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`
    : baseSessionKey;
}
