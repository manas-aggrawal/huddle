/** How the agent runs. Tests override AGENT_OPTIONS to turn it on and speed it up. */
export interface AgentOptions {
	/** Off: sessions are created but no agent works on them (most e2e suites). */
	enabled: boolean;
	/** How often streamed text is written into the doc, in ms. */
	flushMs: number;
}

export const AGENT_OPTIONS = Symbol('AGENT_OPTIONS');

export const defaultAgentOptions = (): AgentOptions => ({
	enabled: process.env.AGENT_ENABLED !== 'false',
	flushMs: Number(process.env.AGENT_FLUSH_MS) || 150,
});
