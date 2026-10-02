import { create } from "zustand";
import type { FilterKey, FrameKey, LayoutKey, StyleKey } from "./types";

export interface CaptureState {
  frames: string[];            // dataURL
  currentJobId: string | null;
  filter: FilterKey;
  style: StyleKey;
  frame: FrameKey;
  layout: LayoutKey;
  aiEnabled: boolean;
  aiImages: string[];
  layoutUrl: string | null;
  setFrames: (f: string[]) => void;
  setCurrentJobId: (id: string | null) => void;
  setFilter: (f: FilterKey) => void;
  setStyle: (s: StyleKey) => void;
  setFrame: (f: FrameKey) => void;
  setLayout: (l: LayoutKey) => void;
  setAiEnabled: (v: boolean) => void;
  setAiImages: (imgs: string[]) => void;
  setLayoutUrl: (u: string | null) => void;
  reset: () => void;
}

export const useStore = create<CaptureState>((set) => ({
  frames: [],
  currentJobId: null,
  filter: "faded_90s",
  style: "PORTRAIT_HK",
  frame: "korean_pink",
  layout: "2x2",
  aiEnabled: false,
  aiImages: [],
  layoutUrl: null,
  setFrames: (f) => set({ frames: f }),
  setCurrentJobId: (id) => set({ currentJobId: id }),
  setFilter: (f) => set({ filter: f }),
  setStyle: (s) => set({ style: s }),
  setFrame: (f) => set({ frame: f }),
  setLayout: (l) => set({ layout: l }),
  setAiEnabled: (v) => set({ aiEnabled: v }),
  setAiImages: (imgs) => set({ aiImages: imgs }),
  setLayoutUrl: (u) => set({ layoutUrl: u }),
  reset: () =>
    set({
      frames: [],
      currentJobId: null,
      aiImages: [],
      layoutUrl: null,
    }),
}));
