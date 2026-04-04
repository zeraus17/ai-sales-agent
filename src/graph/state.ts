import { Annotation } from "@langchain/langgraph";

export const LandingStateAnnotation = Annotation.Root({
  // Inputs del usuario
  prompt:         Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  url_referencia: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Outputs del pipeline
  producto:         Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  copy_hero:        Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  precio_calculado: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  beneficios:       Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),

  // Estado interno de cada nodo
  investigacion: Annotation<Record<string, unknown>>({ reducer: (_, b) => b, default: () => ({}) }),
  estrategia:    Annotation<Record<string, unknown>>({ reducer: (_, b) => b, default: () => ({}) }),
  copy:          Annotation<Record<string, unknown>>({ reducer: (_, b) => b, default: () => ({}) }),
});

export type LandingState = typeof LandingStateAnnotation.State;