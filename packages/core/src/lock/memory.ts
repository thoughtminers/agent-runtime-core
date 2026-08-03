import type { Lease, Lock } from '../types/lock.js';

/** No serialization at all: every claim succeeds immediately, never supersedes. */
export const noopLock: Lock = {
  claim: async (): Promise<Lease> => ({
    signal: new AbortController().signal,
    release: async () => {},
  }),
};

/**
 * In-process per-conversation lock with SUPERSEDE semantics:
 *  - claims for one conversation are served strictly in order (promise chain);
 *  - a new claim aborts every live lease ahead of it (holder AND queued), so
 *    superseded runs observe `signal.aborted` and exit as interrupted, while
 *    the newest claim processes with the fullest context.
 */
export const createInMemoryLock = (): Lock => {
  interface ConversationState {
    live: Set<AbortController>;
    tail: Promise<void>;
  }
  const conversations = new Map<string, ConversationState>();

  return {
    claim: (conversationId): Promise<Lease> => {
      let c = conversations.get(conversationId);
      if (!c) {
        c = { live: new Set(), tail: Promise.resolve() };
        conversations.set(conversationId, c);
      }

      // Supersede everyone ahead of us.
      for (const ctrl of c.live) ctrl.abort();

      const controller = new AbortController();
      c.live.add(controller);

      let markReleased!: () => void;
      const released = new Promise<void>((resolve) => {
        markReleased = resolve;
      });

      const lease: Lease = {
        signal: controller.signal,
        release: async () => {
          c.live.delete(controller);
          markReleased();
        },
      };

      const myTurn = c.tail.then(() => lease);
      c.tail = myTurn.then(() => released);
      return myTurn;
    },
  };
};
