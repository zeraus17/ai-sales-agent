import { Hono } from "hono";
import { cors } from "hono/cors";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

interface Env {
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  AI: Ai;
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


// ─── SUPABASE CACHE ───────────────────────────────────────────────────────────

async function buscarEnCache(url: string, supabaseUrl: string, supabaseKey: string, embedding: number[]): Promise<{
  producto: string;
  descripcion: string;
  markdown: string;
  imagenes: string[];
  costo: number;
} | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/buscar_producto_similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ query_embedding: embedding, similarity_threshold: 0.85, match_count: 1 }),
    });
    const data = await res.json() as { producto: string; descripcion: string; markdown: string; imagenes: string[]; costo_estimado: number }[];
    if (data.length > 0) {
      console.log("[Cache] Hit:", data[0].producto);
      return { ...data[0], costo: data[0].costo_estimado, imagenes: data[0].imagenes || [] };
    }
    return null;
  } catch {
    return null;
  }
}

async function guardarEnCache(
  url: string,
  producto: string,
  descripcion: string,
  markdown: string,
  imagenes: string[],
  costo: number,
  embedding: number[],
  supabaseUrl: string,
  supabaseKey: string
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/rest/v1/productos_cache`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({ url, producto, descripcion, markdown, imagenes, costo_estimado: costo, embedding }),
    });
    console.log("[Cache] Guardado:", producto);
  } catch (err) {
    console.warn("[Cache] Error guardando:", err);
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

    let info: { producto: string; descripcion: string; markdown: string; imagenes: string[]; costo: number };
    let fromCache = false;

    // Generar embedding de la URL para buscar en cache
    if (url_referencia) {
      const embeddingRes = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: url_referencia,
      });
      const embedding = Array.isArray(embeddingRes) ? embeddingRes[0] : (embeddingRes as { data: number[][] }).data[0];

      // Buscar en Supabase
      const cached = await buscarEnCache(url_referencia, c.env.SUPABASE_URL, c.env.SUPABASE_KEY, embedding);
      if (cached) {
        info = cached;
        fromCache = true;
        console.log("[Cache] Hit — saltando scraping");
      } else {
        // Scraping
        info = await investigador(url_referencia, prompt);
        // Guardar en cache
        await guardarEnCache(url_referencia, info.producto, info.descripcion, info.markdown, info.imagenes, info.costo, embedding, c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
      }
    } else {
      info = await investigador("", prompt);
    }

    // Estratega
    let precio = calcularPrecioDropshipping(info.costo, 8, 0.40);
	const precioMatch = prompt.match(/\b(\d+(?:[.,]\d+)?)\b/);
	if (precioMatch) {
		const precioPersonalizado = parseFloat(precioMatch[1].replace(',', '.'));
		if (!isNaN(precioPersonalizado) && precioPersonalizado >= 0) {
			precio = precioPersonalizado;
		}
	}

    // Copywriter
    const copy = await copywriter(info.producto, info.descripcion, precio, prompt, c.env.GEMINI_API_KEY);

    // Arquitecto
    const output: LandingOutput = {
      producto: info.producto,
      angulos: copy.angulos,
      precio_calculado: precio,
      beneficios: copy.beneficios,
      imagenes: info.imagenes,
    };

    return c.json({ ...output, from_cache: fromCache });

  } catch (err) {
    console.error(err);
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

        let fromCache = false;
let info: { producto: string; descripcion: string; markdown: string; imagenes: string[]; costo: number };

if (url) {
  send("status", { nodo: "investigador", mensaje: "Buscando en cache..." });
  const embeddingRes = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: url });
  const embedding = Array.isArray(embeddingRes) ? embeddingRes[0] : (embeddingRes as { data: number[][] }).data[0];
  const cached = await buscarEnCache(url, c.env.SUPABASE_URL, c.env.SUPABASE_KEY, embedding);
  if (cached) {
    info = cached;
    fromCache = true;
    send("status", { nodo: "investigador", mensaje: "Cache hit — saltando scraping." });
  } else {
    send("status", { nodo: "investigador", mensaje: "Iniciando Scraping..." });
    info = await investigador(url, prompt);
    await guardarEnCache(url, info.producto, info.descripcion, info.markdown, info.imagenes, info.costo, embedding, c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
  }
} else {
  send("status", { nodo: "investigador", mensaje: "Iniciando Scraping..." });
  info = await investigador("", prompt);
}

send("status", { nodo: "estratega", mensaje: "Calculando Pricing..." });
let precio = calcularPrecioDropshipping(info.costo, 8, 0.40);
const precioMatch = prompt.match(/\b(\d+(?:[.,]\d+)?)\b/);
if (precioMatch) {
  const precioPersonalizado = parseFloat(precioMatch[1].replace(',', '.'));
  if (!isNaN(precioPersonalizado) && precioPersonalizado >= 0) precio = precioPersonalizado;
}

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

        send("resultado", { ...output, from_cache: fromCache });
        send("fin", { mensaje: "Motor 3Pod completado." });
      }

    } catch {
      send("error", { mensaje: "Error procesando mensaje" });
    }
  });

  return new Response(null, { status: 101, webSocket: client });
});

export default app;