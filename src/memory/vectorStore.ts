import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import * as dotenv from "dotenv";

dotenv.config();

const COLLECTION_NAME = "3pod-productos";
const VECTOR_SIZE = 3072; // dimensión de embedding de Gemini

export const qdrant = new QdrantClient({
  url:    process.env.QDRANT_URL    ?? "",
  apiKey: process.env.QDRANT_API_KEY ?? "",
});

export const embeddings = new GoogleGenerativeAIEmbeddings({
  model:  "gemini-embedding-001",
  apiKey: process.env.GEMINI_API_KEY ?? "",
});

// Inicializa la colección si no existe
export async function initCollection(): Promise<void> {
  try {
    await qdrant.deleteCollection(COLLECTION_NAME);
    console.log("[Qdrant] Coleccion eliminada para recrear");
  } catch {
    // no existia, ok
  }
  await qdrant.createCollection(COLLECTION_NAME, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });
  console.log("[Qdrant] Coleccion creada:", COLLECTION_NAME);
}
// Busca un producto similar en el Vector DB
export async function buscarProducto(query: string): Promise<{
  producto: string;
  descripcion: string;
  markdown: string;
  costo_estimado: number;
} | null> {
  try {
    const vector = await embeddings.embedQuery(query);
    const results = await qdrant.search(COLLECTION_NAME, {
      vector,
      limit: 1,
      score_threshold: 0.85, // similitud mínima del 85%
    });

    if (results.length > 0 && results[0].payload) {
      console.log("[Qdrant] Producto encontrado en Vector DB, score:", results[0].score);
      return results[0].payload as {
        producto: string;
        descripcion: string;
        markdown: string;
        costo_estimado: number;
      };
    }
    return null;
  } catch (err) {
    console.warn("[Qdrant] Error buscando:", err);
    return null;
  }
}

// Guarda un producto en el Vector DB
export async function guardarProducto(data: {
  url: string;
  producto: string;
  descripcion: string;
  markdown: string;
  costo_estimado: number;
}): Promise<void> {
  try {
    const vector = await embeddings.embedQuery(`${data.producto} ${data.descripcion}`);
    const id = Math.abs(hashCode(data.url));

    await qdrant.upsert(COLLECTION_NAME, {
      points: [{
        id,
        vector,
        payload: {
          url:            data.url,
          producto:       data.producto,
          descripcion:    data.descripcion,
          markdown:       data.markdown,
          costo_estimado: data.costo_estimado,
        },
      }],
    });
    console.log("[Qdrant] Producto guardado:", data.producto);
  } catch (err) {
    console.warn("[Qdrant] Error guardando:", err);
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}