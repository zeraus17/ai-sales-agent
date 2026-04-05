import express, { type Request, type Response } from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { engine } from "./graph/workflow.js";
import { responseSchema } from "./schema/response.js";

const app = express();
app.use(express.json());

// Precio base por thread
const precioBase = new Map<string, number>();

// AbortControllers por thread — para interrumpir el LLM en milisegundos
const activeControllers = new Map<string, AbortController>();

const RequestBodySchema = z.object({
  thread_id:      z.union([z.string(), z.number()]),
  prompt:         z.string().min(1, "El prompt no puede estar vacio"),
  url_referencia: z.string().url().optional().nullable(),
});

const nodeMensajes: Record<string, string> = {
  investigador: "Iniciando Scraping...",
  estratega:    "Calculando Pricing...",
  copywriter:   "Generando Copy con IA...",
  arquitecto:   "Ensamblando Landing Page...",
};

/* ─── ENDPOINT NORMAL (HTTP) ─────────────────────────────────────────────── */

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
      imagenes:         result.imagenes         || [],
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

/* ─── HEALTH CHECK ───────────────────────────────────────────────────────── */

app.get("/", (_req: Request, res: Response) => {
  res.send("Motor 3Pod Core Online - WebSocket activo en ws://localhost:PORT/ws");
});

/* ─── SERVIDOR HTTP + WEBSOCKET ──────────────────────────────────────────── */

const server = createServer(app);

// WebSocket en la ruta /ws
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] Cliente conectado");
  let currentThreadId: string | null = null;

  const send = (event: string, data: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  };

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        action: string;
        thread_id?: string | number;
        prompt?: string;
        url_referencia?: string | null;
      };

      /* ── ACCION: DETENER ── */
      if (msg.action === "detener") {
        if (currentThreadId && activeControllers.has(currentThreadId)) {
          activeControllers.get(currentThreadId)!.abort();
          activeControllers.delete(currentThreadId);
          send("status", { mensaje: "Generacion detenida por el usuario." });
          console.log(`[WS] Generacion detenida para thread: ${currentThreadId}`);
        }
        return;
      }

      /* ── ACCION: GENERAR ── */
      if (msg.action === "generar") {
        const { thread_id, prompt, url_referencia } = RequestBodySchema.parse({
          thread_id:      msg.thread_id,
          prompt:         msg.prompt,
          url_referencia: msg.url_referencia,
        });

        const threadId = String(thread_id);
        currentThreadId = threadId;
        const config = { configurable: { thread_id: threadId } };

        // Crear AbortController para este thread
        const controller = new AbortController();
        activeControllers.set(threadId, controller);

        console.log(`\n[WS] SOLICITUD [Thread: ${threadId}]`);
        send("status", { mensaje: "Iniciando motor 3Pod..." });

        try {
          // Streaming nodo por nodo
          const stream = await engine.stream(
            { prompt, url_referencia: url_referencia ?? "" },
            { ...config, streamMode: "updates", signal: controller.signal }
          );

          for await (const chunk of stream) {
            // Si fue abortado, salir
            if (controller.signal.aborted) {
              send("status", { mensaje: "Proceso interrumpido." });
              return;
            }

            const nodo = Object.keys(chunk)[0];
            if (nodo && nodeMensajes[nodo]) {
              send("status", { nodo, mensaje: nodeMensajes[nodo] });
            }
          }

          // Obtener resultado final
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
            imagenes:         result.imagenes         || [],
          });

          send("resultado", finalOutput);
          send("fin", { mensaje: "Motor 3Pod completado." });

        } catch (err) {
          if (controller.signal.aborted) {
            send("status", { mensaje: "Generacion cancelada." });
          } else {
            const msg2 = err instanceof Error ? err.message : "Error desconocido";
            send("error", { mensaje: msg2 });
            console.error("[WS] Error en generacion:", err);
          }
        } finally {
          activeControllers.delete(threadId);
        }

        return;
      }

      send("error", { mensaje: `Accion desconocida: ${msg.action}` });

    } catch (err) {
      if (err instanceof z.ZodError) {
        send("error", { mensaje: "Datos invalidos", detalles: err.issues });
      } else {
        send("error", { mensaje: "Error procesando mensaje" });
      }
    }
  });

  ws.on("close", () => {
    console.log("[WS] Cliente desconectado");
    // Limpiar controller si el cliente se desconecta
    if (currentThreadId && activeControllers.has(currentThreadId)) {
      activeControllers.get(currentThreadId)!.abort();
      activeControllers.delete(currentThreadId);
    }
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });

  send("status", { mensaje: "Conexion establecida con motor 3Pod." });
});

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`Servidor HTTP en http://localhost:${PORT}`);
  console.log(`WebSocket activo en ws://localhost:${PORT}/ws`);
});