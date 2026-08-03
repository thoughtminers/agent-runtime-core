/**
 * Per-conversation serialization with SUPERSEDE semantics: claiming a
 * conversation that already has a live lease aborts that lease's run (its
 * `signal` fires) and resolves once it releases. The newer message then
 * processes with the fuller context — "abort the previous" by construction.
 *
 * Queue/drain semantics (process every message eventually) belong to the
 * transport layer above the harness.
 */

export interface Lease {
  /** Fires when a newer claim supersedes this run — threaded into the loop. */
  signal: AbortSignal;
  release(): Promise<void>;
}

export interface Lock {
  claim(conversationId: string): Promise<Lease>;
}
