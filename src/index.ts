import express, { type Request, type Response } from "express";
import { z } from "zod";
import { engine } from "./graph/workflow.ts";
import { responseSchema } from "./schema/response.ts";

const app = express();
app.use(express.json());

// Precio base por thread (para ajustes sin re-calcular desde cero)
const precioBase = new Map<string, number>();

const RequestBodySchema = z.object({
  thread_id:      z.union([z.string(), z.number()]),
  prompt:         z.string().min(1, "El prompt no puede estar vacio"),
  url_referencia: z.string().url().optional().nullable(),
});

/* ─── ENDPOINT NORMAL ────────────────────────────────────────────────────── */

app.post("/api/v1/generate-landing", async (req: Request, res: Response) => {
  try {
    const { thread_id, prompt, url_referencia } = RequestBodySchema.parse(req.body);
    const threadId = String(thread_id);
    const config   = { configurable: { thread_id: threadId } };

    console.log(`\n--- SOLICITUD [Thread: ${threadId}] ---`);

    const result = await engine.invoke(
      { prompt, url_referencia: url_referencia ?? "" },
      config
    );

    if (!precioBase.has(threadId)) {
      precioBase.set(threadId, result.precio_calculado || 0);
    }

    const base = precioBase.get(threadId)!;
    let precioFinal = base;

    const promptLower = prompt.toLowerCase();
    if (promptLower.includes("baja")) {
      precioFinal = parseFloat((base * 0.8).toFixed(2));
      console.log(`Precio bajado: ${base} -> ${precioFinal}`);
    } else if (promptLower.includes("sube")) {
      precioFinal = parseFloat((base * 1.2).toFixed(2));
      console.log(`Precio subido: ${base} -> ${precioFinal}`);
    }

    const finalOutput = responseSchema.parse({
      producto:         result.producto         || "Producto sin nombre",
      copy_hero:        result.copy_hero        || "",
      precio_calculado: precioFinal,
      beneficios:       result.beneficios       || [],
    });

    return res.json(finalOutput);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Datos invalidos", detalles: error.issues });
    }
    console.error("Error:", error);
    return res.status(500).json({ error: "Fallo critico en el motor" });
  }
});

/* ─── ENDPOINT STREAMING (SSE) ───────────────────────────────────────────── */
// Uso: POST /api/v1/generate-landing/stream
// El cliente recibe eventos en tiempo real mientras el grafo procesa cada nodo

app.post("/api/v1/generate-landing/stream", async (req: Request, res: Response) => {
  try {
    const { thread_id, prompt, url_referencia } = RequestBodySchema.parse(req.body);
    const threadId = String(thread_id);
    const config   = { configurable: { thread_id: threadId } };

    // Cabeceras SSE
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("status", { mensaje: "Iniciando motor 3Pod..." });

    // engine.stream() emite el estado después de cada nodo
    const stream = await engine.stream(
      { prompt, url_referencia: url_referencia ?? "" },
      { ...config, streamMode: "updates" }
    );

    const nodeMensajes: Record<string, string> = {
      investigador: "Scraping del producto...",
      estratega:    "Calculando precio dropshipping...",
      copywriter:   "Generando copy persuasivo...",
      arquitecto:   "Ensamblando landing page...",
    };

    for await (const chunk of stream) {
      const nodo = Object.keys(chunk)[0];
      if (nodo && nodeMensajes[nodo]) {
        send("status", { nodo, mensaje: nodeMensajes[nodo] });
      }
    }

    // Invocamos de nuevo para obtener el estado final completo
    const result = await engine.invoke(
      { prompt, url_referencia: url_referencia ?? "" },
      config
    );

    if (!precioBase.has(threadId)) {
      precioBase.set(threadId, result.precio_calculado || 0);
    }

    const base = precioBase.get(threadId)!;
    let precioFinal = base;
    const promptLower = prompt.toLowerCase();
    if (promptLower.includes("baja")) precioFinal = parseFloat((base * 0.8).toFixed(2));
    if (promptLower.includes("sube")) precioFinal = parseFloat((base * 1.2).toFixed(2));

    const finalOutput = responseSchema.parse({
      producto:         result.producto         || "Producto sin nombre",
      copy_hero:        result.copy_hero        || "",
      precio_calculado: precioFinal,
      beneficios:       result.beneficios       || [],
    });

    send("resultado", finalOutput);
    send("fin", { mensaje: "Motor 3Pod completado." });
    res.end();

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Datos invalidos" })}\n\n`);
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Fallo critico" })}\n\n`);
    }
    res.end();
  }
});

/* ─── HEALTH CHECK ───────────────────────────────────────────────────────── */

app.get("/", (_req: Request, res: Response) => {
  res.send("Motor 3Pod Core Online");
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});