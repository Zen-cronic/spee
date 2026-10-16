// Synthetic contract payloads for tests.
import type { LiveWindow } from "../src/hub/contract.js";
import { window1 } from "../src/hub/contractExamples.js";

export const liveWindows = (conversationId: string, n: number): LiveWindow[] =>
  Array.from({ length: n }, (_, i) => ({ ...window1, conversationId, updatedAt: window1.updatedAt + i * 1000 + (conversationId === "conv-b" ? 500 : 0) }));
