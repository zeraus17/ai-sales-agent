import { Hono } from "hono";
import { cors } from "hono/cors";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

interface Env {
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}

interface Angulos {
  agresivo: string[];
  emocional: string[];
  logico: string[];
}

interface LandingOutput {
  producto: string;
  angulos: Angulos;
  precio_calculado: number;
  beneficios: string[];
  imagenes: string[];
}

// ─── CALCULAR PRECIO ──────────────────────────────────────────────────────────

function calcularPrecioDropshipping(costo: number, cpa: number, margen: number): number {
  return parseFloat(((costo + cpa) / (1 - margen)).toFixed(2));
}

// ─── INVESTIGADOR ─────────────────────────────────────────────────────────────

async function investigador(url: string, prompt: string): Promise<{
  producto: string;
  descripcion: string;
  markdown: string;
  imagenes: string[];
  costo: number;
}> {
  if (!url) {
    return { producto: prompt, descripcion: `Solución ideal: ${prompt}`, markdown: "", imagenes: [], costo: 30 };
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; 3Pod/1.0)" },
      signal: AbortSignal.timeout(8000),
    });

    const html = await res.text();

    // HTMLRewriter extrae datos del HTML (nativo de Cloudflare)
    let producto = "";
    let descripcion = "";
    const imagenes: string[] = [];

    class MetaHandler {
      element(el: Element) {
        const prop = el.getAttribute("property") || el.getAttribute("name") || "";
        const content = el.getAttribute("content") || "";
        if (prop === "og:title" && !producto) producto = content;
        if ((prop === "og:description" || prop === "description") && !descripcion) descripcion = content;
      }
    }

    class TitleHandler {
      text(chunk: Text) {
        if (!producto && chunk.text.trim()) producto = chunk.text.trim();
      }
    }

    class ImgHandler {
      element(el: Element) {
        if (imagenes.length >= 3) return;
        const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
        if (!src || src.startsWith("data:") || src.endsWith(".svg")) return;
        const width = parseInt(el.getAttribute("width") || "0");
        const height = parseInt(el.getAttribute("height") || "0");
        if ((width > 0 && width < 100) || (height > 0 && height < 100)) return;
        const absolute = src.startsWith("http") ? src : `${new URL(url).origin}${src}`;
        if (!imagenes.includes(absolute)) imagenes.push(absolute);
      }
    }

    // Usamos un Response falso para poder usar HTMLRewriter
    const rewriter = new HTMLRewriter()
      .on("meta", new MetaHandler())
      .on("title", new TitleHandler())
      .on("img", new ImgHandler());

    await rewriter.transform(new Response(html)).text();

    // Limpiar título
    producto = producto.replace(/\s*[-–—|]\s*.+$/, "").trim();
    if (producto.length < 5) producto = prompt;
    if (!descripcion) descripcion = `Solución ideal: ${producto}`;

    return { producto, descripcion, markdown: html.slice(0, 2000), imagenes, costo: 30 };

  } catch {
    return { producto: prompt, descripcion: `Solución ideal: ${prompt}`, markdown: "", imagenes: [], costo: 30 };
  }
}

// ─── COPYWRITER CON GEMINI ────────────────────────────────────────────────────

async function copywriter(
  producto: string,
  descripcion: string,
  precio: number,
  promptUsuario: string,
  apiKey: string
): Promise<{ angulos: Angulos; beneficios: string[] }> {
  const prompt = `
Eres un copywriter experto en ventas para landing pages de dropshipping en Latinoamerica.
Producto: ${producto}
Descripcion: ${descripcion}
Precio: $${precio}
Instruccion: ${promptUsuario}

Genera UNICAMENTE un JSON valido sin backticks:
{
  "angulos": {
    "agresivo": ["frase 1", "frase 2", "frase 3"],
    "emocional": ["frase 1", "frase 2", "frase 3"],
    "logico": ["frase 1", "frase 2", "frase 3"]
  },
  "beneficios": ["beneficio 1", "beneficio 2", "beneficio 3"]
}`.trim();

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
    const text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text) as { angulos: Angulos; beneficios: string[] };
    return parsed;

  } catch {
    return {
      angulos: {
        agresivo: ["¡Últimas unidades! Comprá ahora.", "Oferta limitada, no esperes.", "Actúa ya, precio exclusivo."],
        emocional: ["Transforma tu vida hoy.", "Lo que siempre quisiste, ahora.", "Tu familia se lo merece."],
        logico: ["Ahorrá un 40% vs competencia.", "Calidad comprobada por miles.", "Envío rápido garantizado."],
      },
      beneficios: ["Calidad garantizada", "Envío rápido", "Soporte incluido"],
    };
  }
}

// ─── HONO APP ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) => c.text("Motor 3Pod - Cloudflare Workers 🚀"));

app.post("/api/v1/generate-landing", async (c) => {
  try {
    const { thread_id, prompt, url_referencia } = await c.req.json<{
      thread_id: string;
      prompt: string;
      url_referencia?: string;
    }>();

    if (!prompt) return c.json({ error: "prompt requerido" }, 400);

    // 1. Investigador
    const info = await investigador(url_referencia || "", prompt);

    // 2. Estratega
    const precio = calcularPrecioDropshipping(info.costo, 8, 0.40);

    // 3. Copywriter
    const copy = await copywriter(info.producto, info.descripcion, precio, prompt, c.env.GEMINI_API_KEY);

    // 4. Arquitecto
    const output: LandingOutput = {
      producto: info.producto,
      angulos: copy.angulos,
      precio_calculado: precio,
      beneficios: copy.beneficios,
      imagenes: info.imagenes,
    };

    return c.json(output);

  } catch (err) {
    return c.json({ error: "Error en el motor" }, 500);
  }
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

app.get("/ws", async (c) => {
  const upgrade = c.req.header("Upgrade");
  if (upgrade !== "websocket") return c.text("Expected WebSocket", 426);

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  const send = (event: string, data: unknown) => {
    server.send(JSON.stringify({ event, data }));
  };

  send("status", { mensaje: "Conexion establecida con motor 3Pod." });

  server.addEventListener("message", async (evt) => {
    try {
      const msg = JSON.parse(evt.data as string) as {
        action: string;
        thread_id?: string;
        prompt?: string;
        url_referencia?: string;
      };

      if (msg.action === "detener") {
        send("status", { mensaje: "Proceso detenido." });
        return;
      }

      if (msg.action === "generar") {
        const prompt = msg.prompt || "";
        const url = msg.url_referencia || "";

        send("status", { nodo: "investigador", mensaje: "Iniciando Scraping..." });
        const info = await investigador(url, prompt);

        send("status", { nodo: "estratega", mensaje: "Calculando Pricing..." });
        const precio = calcularPrecioDropshipping(info.costo, 8, 0.40);

        send("status", { nodo: "copywriter", mensaje: "Generando Copy con IA..." });
        const copy = await copywriter(info.producto, info.descripcion, precio, prompt, c.env.GEMINI_API_KEY);

        send("status", { nodo: "arquitecto", mensaje: "Ensamblando Landing Page..." });

        const output: LandingOutput = {
          producto: info.producto,
          angulos: copy.angulos,
          precio_calculado: precio,
          beneficios: copy.beneficios,
          imagenes: info.imagenes,
        };

        send("resultado", output);
        send("fin", { mensaje: "Motor 3Pod completado." });
      }

    } catch {
      send("error", { mensaje: "Error procesando mensaje" });
    }
  });

  return new Response(null, { status: 101, webSocket: client });
});

export default app;