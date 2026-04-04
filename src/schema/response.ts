import { z } from "zod";

export const responseSchema = z.object({
  producto:         z.string().min(1),
  copy_hero:        z.string().min(1),
  precio_calculado: z.number().nonnegative(),
  beneficios:       z.array(z.string()).min(1),
});

export type ResponseOutput = z.infer<typeof responseSchema>;