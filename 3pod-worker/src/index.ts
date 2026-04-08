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

const NOMBRES_SITIOS = ["mercado libre", "amazon", "ebay", "aliexpress", "walmart", "etsy"];
const SITIOS_BLOQUEADORES = ["mercadolibre", "amazon", "ebay", "aliexpress", "walmart", "etsy", "shopee"];

function extraerProductoDeURL(rawUrl: string): string {
  try {
    const path = new URL(rawUrl).pathname;
    const segmentos = path
      .split("/")
      .filter(s =>
        s.length > 3 &&
        !/^[A-Z]{2,}\d+$/.test(s) &&
        !/^(dp|gp|product|item|p|listing|s|ref|pd|pf)$/i.test(s) &&
        !/^\d+$/.test(s)
      );
    const candidato = segmentos[0] || "";
    return candidato
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  } catch { return ""; }
}

async function investigador(url: string, prompt: string, apiKey: string): Promise<{
  producto: string;
  descripcion: string;
  markdown: string;
  imagenes: string[];
  costo: number;
}> {
  if (!url) {
    return { producto: prompt, descripcion: `Solución ideal: ${prompt}`, markdown: "", imagenes: [], costo: 30 };
  }

  const dominioCheck = new URL(url).hostname.replace("www.", "");
  const esSitioBlockeado = SITIOS_BLOQUEADORES.some(s => dominioCheck.includes(s));

  if (esSitioBlockeado) {
    const productoDeURL = extraerProductoDeURL(url);
    const esID = /^[A-Z0-9]{5,}$/.test(productoDeURL.replace(/\s/g, ""));

    if (productoDeURL && productoDeURL.length > 3 && !esID) {
      return {
        producto: productoDeURL,
        descripcion: `Producto disponible en ${dominioCheck}: ${productoDeURL}`,
        markdown: "",
        imagenes: [],
        costo: 30
      };
    }

    // Fallback: pedirle a Gemini que infiera el producto desde la URL
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Esta es una URL de un producto en ${dominioCheck}: ${url}

Basándote SOLO en la URL, inferí el tipo de producto que podría ser. Si no podés determinarlo, respondé "Producto General".
Respondé SOLO con JSON válido sin backticks:
{"producto": "nombre inferido del producto", "descripcion": "descripción breve en una oración"}`
              }]
            }]
          }),
        }
      );
      const geminiData = await geminiRes.json() as { candidates: { content: { parts: { text: string }[] } }[] };
      const geminiText = geminiData.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(geminiText) as { producto: string; descripcion: string };
      return {
        producto: parsed.producto || prompt,
        descripcion: parsed.descripcion || `Producto disponible en ${dominioCheck}`,
        markdown: "",
        imagenes: [],
        costo: 30
      };
    } catch {
      return { producto: prompt, descripcion: `Producto disponible en ${dominioCheck}`, markdown: "", imagenes: [], costo: 30 };
    }
  }

  // Scraping normal para sitios que no bloquean
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(8000),
    });

    const html = await res.text();

    let ogTitle = "";
    let h1Text = "";
    let descripcion = "";
    const imagenes: string[] = [];

    class MetaHandler {
      element(el: Element) {
        const prop = el.getAttribute("property") || el.getAttribute("name") || "";
        const content = el.getAttribute("content") || "";
        if (prop === "og:title" && !ogTitle) ogTitle = content;
        if ((prop === "og:description" || prop === "description") && !descripcion) descripcion = content;
      }
    }

    class H1Handler {
      text(chunk: Text) {
        if (!h1Text && chunk.text.trim().length > 3) h1Text += chunk.text.trim();
      }
    }

    class ImgHandler {
      element(el: Element) {
        if (imagenes.length >= 3) return;
        const src = el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || "";
        if (!src || src.startsWith("data:") || src.endsWith(".svg")) return;
        const width = parseInt(el.getAttribute("width") || "0");
        const height = parseInt(el.getAttribute("height") || "0");
        if ((width > 0 && width < 100) || (height > 0 && height < 100)) return;
        const absolute = src.startsWith("http") ? src : `${new URL(url).origin}${src}`;
        if (!imagenes.includes(absolute)) imagenes.push(absolute);
      }
    }

    const rewriter = new HTMLRewriter()
      .on("meta", new MetaHandler())
      .on("h1", new H1Handler())
      .on("img", new ImgHandler());

    await rewriter.transform(new Response(html)).text();

    const dominio = new URL(url).hostname.replace("www.", "");

    const textoLimpio = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 2000);

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Analiza este texto extraído de una página web de ecommerce y extrae el nombre ESPECÍFICO del producto que se vende (no el nombre del sitio web).
H1: ${h1Text || "no disponible"}
OG:TITLE: ${ogTitle || "no disponible"}
URL: ${url}
TEXTO: ${textoLimpio}

Si no podés determinar el producto específico, responde con "NO_ENCONTRADO".
Responde SOLO con JSON válido sin backticks:
{"producto": "nombre exacto del producto", "descripcion": "descripción breve del producto en una oración"}`
            }]
          }]
        }),
      }
    );

    let producto = "";
    let descripcionGemini = "";

    try {
      const geminiData = await geminiRes.json() as { candidates: { content: { parts: { text: string }[] } }[] };
      const geminiText = geminiData.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(geminiText) as { producto: string; descripcion: string };
      producto = parsed.producto || "";
      descripcionGemini = parsed.descripcion || "";
    } catch {
      producto = h1Text || ogTitle || "";
    }

    producto = producto.replace(new RegExp(`\\s*[-–—|:]\\s*${dominio}.*$`, "i"), "").trim();

    const esNombreSitio = NOMBRES_SITIOS.some(s => producto.toLowerCase().includes(s));
    const esNoEncontrado = producto === "NO_ENCONTRADO" || producto.length < 3;

    if (esNombreSitio || esNoEncontrado) {
      if (h1Text && !NOMBRES_SITIOS.some(s => h1Text.toLowerCase().includes(s))) {
        producto = h1Text;
      } else if (ogTitle && !NOMBRES_SITIOS.some(s => ogTitle.toLowerCase().includes(s))) {
        producto = ogTitle.replace(new RegExp(`\\s*[-–—|:]\\s*${dominio}.*$`, "i"), "").trim();
      } else {
        producto = extraerProductoDeURL(url) || prompt;
      }
    }

    if (!producto || producto.length < 3) producto = prompt;

    const descripcionFinal = descripcionGemini && !NOMBRES_SITIOS.some(s => descripcionGemini.toLowerCase().includes(s))
      ? descripcionGemini
      : (descripcion || `Producto: ${producto}`);

    return { producto, descripcion: descripcionFinal, markdown: textoLimpio, imagenes, costo: 30 };

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

    if (url_referencia) {
      const embeddingRes = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: url_referencia });
      const embedding = Array.isArray(embeddingRes) ? embeddingRes[0] : (embeddingRes as { data: number[][] }).data[0];

      const cached = await buscarEnCache(url_referencia, c.env.SUPABASE_URL, c.env.SUPABASE_KEY, embedding);
      if (cached) {
        info = cached;
        fromCache = true;
      } else {
        info = await investigador(url_referencia, prompt, c.env.GEMINI_API_KEY);
        await guardarEnCache(url_referencia, info.producto, info.descripcion, info.markdown, info.imagenes, info.costo, embedding, c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
      }
    } else {
      info = await investigador("", prompt, c.env.GEMINI_API_KEY);
    }

    let precio = calcularPrecioDropshipping(info.costo, 8, 0.40);
    const precioMatch = prompt.match(/\b(\d+(?:[.,]\d+)?)\b/);
    if (precioMatch) {
      const precioPersonalizado = parseFloat(precioMatch[1].replace(',', '.'));
      if (!isNaN(precioPersonalizado) && precioPersonalizado >= 0) precio = precioPersonalizado;
    }

    const copy = await copywriter(info.producto, info.descripcion, precio, prompt, c.env.GEMINI_API_KEY);

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
        cache_enabled?: boolean;
      };

      if (msg.action === "detener") {
        send("status", { mensaje: "Proceso detenido." });
        return;
      }

      if (msg.action === "generar") {
        const prompt = msg.prompt || "";
        const url = msg.url_referencia || "";
        const cacheEnabled = msg.cache_enabled !== false;

        let fromCache = false;
        let info: { producto: string; descripcion: string; markdown: string; imagenes: string[]; costo: number };

        if (url) {
          send("status", { nodo: "investigador", mensaje: "Buscando en cache..." });
          const embeddingRes = await c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: url });
          const embedding = Array.isArray(embeddingRes) ? embeddingRes[0] : (embeddingRes as { data: number[][] }).data[0];

          const cached = cacheEnabled ? await buscarEnCache(url, c.env.SUPABASE_URL, c.env.SUPABASE_KEY, embedding) : null;

          if (cached) {
            info = cached;
            fromCache = true;
            send("status", { nodo: "investigador", mensaje: "Cache hit — saltando scraping." });
          } else {
            send("status", { nodo: "investigador", mensaje: "Iniciando Scraping..." });
            info = await investigador(url, prompt, c.env.GEMINI_API_KEY);
            await guardarEnCache(url, info.producto, info.descripcion, info.markdown, info.imagenes, info.costo, embedding, c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
          }
        } else {
          send("status", { nodo: "investigador", mensaje: "Iniciando Scraping..." });
          info = await investigador("", prompt, c.env.GEMINI_API_KEY);
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