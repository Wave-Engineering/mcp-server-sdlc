import { z } from 'zod';

export interface HandlerDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}
