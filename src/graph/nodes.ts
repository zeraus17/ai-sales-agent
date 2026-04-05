import axios from "axios";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";
import type { LandingState } from "./state.js";
import { buscarProducto, guardarProducto, initCollection } from "../memory/vectorStore.js";

dotenv.config();
initCollection().catch(console.error);
const turndown = new TurndownService();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

interface DropshippingParams {
  costoProducto: number;
  cpa: number;
  margen: number;
}

function calcularPrecioDropshipping({ costoProducto, cpa, margen }: DropshippingParams): number {
  if (margen >= 1) throw new Error("El margen debe ser menor a 1");
  const precio = (costoProducto + cpa) / (1 - margen);
  return parseFloat(precio.toFixed(2));
}

export async function investigadorNode(state: LandingState): Promise<Partial<LandingState>> {
  if (state.producto && Object.keys(state.investigacion).length > 0) {
    console.log("Investigador: Datos en memoria, salteando scraping.");
    return {};
  }
  console.log("Investigador: Analizando prompt y URL...");
  let producto: string | null = null;
  let descripcionRaw: string | null = null;
  let costoEstimado = 30;
  let markdown = "";
  const imagenes: string[] = [];

  // PASO 1: Buscar en Vector DB primero
  if (state.url_referencia) {
    const cached = await buscarProducto(state.url_referencia);
    if (cached) {
      console.log("[Investigador] Cache hit en Qdrant:", cached.producto);
      const investigacion: Record<string, unknown> = {
        fuente:         "vector-db",
        url:            state.url_referencia,
        descripcion:    cached.descripcion,
        costo_estimado: cached.costo_estimado,
        markdown:       cached.markdown,
      };
      return { producto: cached.producto, investigacion };
    }
  }

  // PASO 2: Si no está en Vector DB, hacer scraping
  if (state.url_referencia) {
    try {
      const { data: html } = await axios.get(state.url_referencia, {
        timeout: 8000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "es-ES,es;q=0.9",
        },
      });

      const $ = cheerio.load(html);
      const bodyHtml = $("body").html() ?? "";
      markdown = turndown.turndown(bodyHtml).slice(0, 3000);

      const rawTitle =
        $('meta[property="og:title"]').attr("content") ??
        $('meta[name="twitter:title"]').attr("content") ??
        $("title").text().trim() ??
        $("h1").first().text().trim();

      const rawDesc =
        $('meta[property="og:description"]').attr("content") ??
        $('meta[name="twitter:description"]').attr("content") ??
        $('meta[name="description"]').attr("content");

      const bodyText = $("body").text();
      const precioMatch = bodyText.match(/(?:USD|ARS|\$)\s*([\d.,]+)/i);
      if (precioMatch) {
        const parsed = parseFloat(precioMatch[1].replace(",", "."));
        if (!isNaN(parsed) && parsed > 0) costoEstimado = parsed;
      }

      const cleanTitle = rawTitle?.replace(/\s*[-–—|]\s*.+$/, "").trim() ?? null;
      producto = cleanTitle && cleanTitle.length >= 5 ? cleanTitle : null;
      descripcionRaw = rawDesc && rawDesc.length >= 10 ? rawDesc : null;

      $("img").each((_i, el) => {
        if (imagenes.length >= 3) return false;
        const src =
          $(el).attr("src") ??
          $(el).attr("data-src") ??
          $(el).attr("data-lazy-src");
        if (!src) return;
        if (src.startsWith("data:")) return;
        const width  = parseInt($(el).attr("width")  ?? "0");
        const height = parseInt($(el).attr("height") ?? "0");
        if (width > 0 && width < 100) return;
        if (height > 0 && height < 100) return;
        if (src.endsWith(".svg")) return;
        const absolute = src.startsWith("http")
          ? src
          : `https://${new URL(state.url_referencia).hostname}${src}`;
        if (!imagenes.includes(absolute)) imagenes.push(absolute);
      });

      console.log("[Investigador] producto ->", producto);
      console.log("[Investigador] costo estimado ->", costoEstimado);
      console.log("[Investigador] imagenes ->", imagenes);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      console.warn("[Investigador] Scraping fallo:", msg);
    }
  }

  if (!producto) {
    producto = state.prompt.trim() || "Producto digital";
    console.log("[Investigador] Fallback al prompt ->", producto);
  }

  const investigacion: Record<string, unknown> = {
    fuente:         state.url_referencia ? "scraping" : "prompt",
    url:            state.url_referencia || null,
    descripcion:    descripcionRaw ?? `Solucion ideal: ${producto}`,
    costo_estimado: costoEstimado,
    markdown,
  };

  // PASO 3: Guardar en Vector DB para futuros usuarios
  if (state.url_referencia && producto) {
    await guardarProducto({
      url:            state.url_referencia,
      producto,
      descripcion:    String(investigacion.descripcion),
      markdown,
      costo_estimado: costoEstimado,
    });
  }

  return { producto, investigacion, imagenes };
}

export async function estrategaNode(state: LandingState): Promise<Partial<LandingState>> {
  console.log("Estratega: Calculando precio con calcular_precio_dropshipping...");
  const costoProducto = (state.investigacion["costo_estimado"] as number | undefined) ?? 30;
  const cpa    = 8;
  const margen = 0.40;
  const precio_calculado = calcularPrecioDropshipping({ costoProducto, cpa, margen });
  console.log(`[Estratega] Costo: $${costoProducto} | CPA: $${cpa} | Margen: ${margen * 100}% | Precio: $${precio_calculado}`);
  const estrategia: Record<string, unknown> = {
    costo_producto: costoProducto,
    cpa,
    margen,
    formula: `(${costoProducto} + ${cpa}) / (1 - ${margen}) = ${precio_calculado}`,
  };
  return { estrategia, precio_calculado };
}

export async function copywriterNode(state: LandingState): Promise<Partial<LandingState>> {
  console.log("Copywriter: Generando copy con Gemini...");

  const descripcion =
    (state.investigacion["descripcion"] as string | undefined) ??
    "Producto de alta calidad.";

  const markdown =
    (state.investigacion["markdown"] as string | undefined) ?? "";

  const prompt = `
Eres un copywriter experto en ventas para landing pages de dropshipping en Latinoamerica.

Producto: ${state.producto}
Descripcion: ${descripcion}
Precio: $${state.precio_calculado}
Contexto del producto (en Markdown):
${markdown}
Instruccion del cliente: ${state.prompt}

Genera UNICAMENTE un JSON valido con esta estructura exacta, sin texto extra, sin backticks:
{
  "copy_hero": "frase de impacto de una sola oracion, maximo 15 palabras, orientada a conversion",
  "beneficios": ["beneficio 1", "beneficio 2", "beneficio 3"]
}
`.trim();

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    console.log("[Copywriter] Respuesta Gemini:", text);
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as { copy_hero: string; beneficios: string[] };
    const copy: Record<string, unknown> = { hero_draft: parsed.copy_hero };
    return { copy, copy_hero: parsed.copy_hero, beneficios: parsed.beneficios };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error desconocido";
    console.warn("[Copywriter] Gemini fallo, usando fallback:", msg);
    return {
      copy:      { hero_draft: `Descubri ${state.producto}` },
      copy_hero: `Descubri ${state.producto}. ${descripcion}`,
      beneficios: [
        "Calidad garantizada",
        "Envio rapido a todo el pais",
        "Soporte personalizado incluido",
      ],
    };
  }
}

export async function arquitectoNode(state: LandingState): Promise<Partial<LandingState>> {
  console.log("Arquitecto: Validando estructura final...");
  return {
    producto:         state.producto         || "Producto sin nombre",
    copy_hero:        state.copy_hero        || "Tu solucion ideal te espera",
    precio_calculado: state.precio_calculado || 0,
    beneficios:       state.beneficios?.length ? state.beneficios : ["Calidad garantizada"],
    imagenes:         state.imagenes?.length  ? state.imagenes  : [],
  };
}