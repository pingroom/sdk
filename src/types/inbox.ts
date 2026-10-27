import type {
  HandoffQuestionState,
  HandoffOption,
  HandoffAnswer,
  Handoff,
  WaitHandoffInput,
} from './handoffs.js';

// --- Agent Inbox ---------------------------------------------------------

/** Idempotent first-connect result from POST /api/agent/inbox/ensure. */
export interface AgentInboxEnsureResult {
  onboarded: true;
  replayed: boolean;
  room: {
    id: string;
    name: string;
    invite_code: string;
    is_agent_inbox: boolean;
  };
  question: {
    id: string;
    kind: 'question';
    prompt: string;
    options: HandoffOption[];
    state: HandoffQuestionState;
    expires_at: string | null;
    created_at: string | null;
  };
}

/** Cancellation for the idempotent Agent Inbox ensure request. */
export interface AgentInboxEnsureInput {
  signal?: AbortSignal;
}

/**
 * Controls the activation handoff wait. `timeout` is the duration of each
 * bounded server hold; a still-pending response is polled again until the
 * server confirms activation, the Question expires/cancels, the overall
 * deadline elapses, or `signal` is aborted.
 */
export interface AgentInboxActivateInput extends WaitHandoffInput {
  /**
   * Wall-clock limit for ensure + every pending long-poll combined. Defaults
   * to 120000 (two minutes). Distinct from `timeout`, which controls one hold.
   */
  overallTimeoutMs?: number;
}

/** The terminal question returned by a completed Agent Inbox activation. */
export type AgentInboxActivationQuestion =
  Handoff & {
    kind: 'question';
    state: 'answered';
    answer: HandoffAnswer;
    activation_completed: true;
  };

/** `ensure` metadata plus the terminal, fully resolved onboarding handoff. */
export type AgentInboxActivationResult = Omit<AgentInboxEnsureResult, 'question'> & {
  activation_completed: true;
  question: AgentInboxActivationQuestion;
};
