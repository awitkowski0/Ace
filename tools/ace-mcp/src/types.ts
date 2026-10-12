import type { z } from "zod";
import type { Bridge } from "./bridge";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolOutput {
  [k: string]: unknown;
  content: Content[];
  isError?: boolean;
}

export interface Ctx {
  /** Absolute, real paths. Every file argument must resolve inside one of them. */
  roots: string[];
  bridge: Bridge;
}

export interface ToolDef {
  name: string;
  /** Written for Claude: when to use it, what it returns. */
  description: string;
  shape: z.ZodRawShape;
  /** read-only tools never change anything */
  readOnly?: boolean;
  /** needs Ace running (registered but hidden/erroring without it) */
  live?: boolean;
  handler: (args: any, ctx: Ctx) => Promise<ToolOutput>;
}

export const text = (t: string): ToolOutput => ({ content: [{ type: "text", text: t }] });
export const fail = (t: string): ToolOutput => ({ content: [{ type: "text", text: t }], isError: true });

/** Error whose message is shown to Claude as-is (bad arguments, missing names ...). */
export class UserError extends Error {}
