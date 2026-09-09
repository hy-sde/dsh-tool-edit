/**
 * Schema for the `edit` tool's hashline mode payload. Deliberately
 * permissive (allows extra keys) so providers can attach extras without
 * rejection; only `input` is required. Defined against the harness schemastery
 * vocabulary (equivalent to the original arktype object).
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

export const hashlineEditParamsSchema = {
  input: {
    type: 'string',
    description: 'The hashline patch, i.e. insertion/appending/replacement text surrounded by `[path#tag]` headers plus edit operations.',
  },
} satisfies ParameterSchemaSpec

/** Parsed hashline mode parameters. */
export interface HashlineParams {
  input: string
}
