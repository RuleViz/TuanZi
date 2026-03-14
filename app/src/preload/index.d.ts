import type { TuanziAPI } from "../shared/ipc-contracts";

export type { TuanziAPI };
export * from "../shared/domain-types";
export * from "../shared/ipc-contracts";

declare global {
  interface Window {
    tuanzi: TuanziAPI;
  }
}
