import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { LandingStateAnnotation } from "./state.ts";
import {
  investigadorNode,
  estrategaNode,
  copywriterNode,
  arquitectoNode,
} from "./nodes.ts";

// Memoria persistente mientras el proceso esté vivo
const memory = new MemorySaver();

const workflow = new StateGraph(LandingStateAnnotation)
  .addNode("investigador", investigadorNode)
  .addNode("estratega",    estrategaNode)
  .addNode("copywriter",   copywriterNode)
  .addNode("arquitecto",   arquitectoNode)
  .addEdge(START,          "investigador")
  .addEdge("investigador", "estratega")
  .addEdge("estratega",    "copywriter")
  .addEdge("copywriter",   "arquitecto")
  .addEdge("arquitecto",   END);

// ReturnType evita anotar manualmente el tipo complejo de LangGraph
export const engine = workflow.compile({ checkpointer: memory });