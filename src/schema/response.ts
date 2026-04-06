import { z } from "zod";

export const AngulosSchema = z.object({
  agresivo: z.array(z.string()).length(3),
  emocional: z.array(z.string()).length(3),
  logico:    z.array(z.string()).length(3),
});

export const responseSchema = z.object({
  producto:         z.string().min(1),
  angulos:          AngulosSchema,
  precio_calculado: z.number().nonnegative(),
  beneficios:       z.array(z.string()).min(1),
  imagenes:         z.array(z.string()).default([]),
});

export type ResponseOutput = z.infer<typeof responseSchema>;
export type Angulos = z.infer<typeof AngulosSchema>;