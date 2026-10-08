export interface LookDemoSnapshot {
  L: { frame: { x: number; y: number; w: number; h: number }; sidebarW: number; rail: { x: number; y: number; w: number; h: number }; docH: number; PW: number; PH: number };
  markers: unknown[];
  side: unknown[];
  tabs: unknown[];
  rail: { states: Record<string, unknown>; trend: unknown };
}

/** 데모를 root 안의 [data-demo] 요소들에 붙이고, 정리 함수를 돌려준다. */
export function mountLookDemo(root: HTMLElement, options: { snapshot: LookDemoSnapshot; assetRoot: string }): () => void;
