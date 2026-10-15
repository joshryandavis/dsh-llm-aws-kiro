/**
 * Structured reasoning-effort handling for Kiro runtime requests. The
 * authenticated management catalog discloses each model's effort schema (the
 * `additionalModelRequestFields` enum); before discovery runs, known models
 * fall back to hardcoded ladders. The harness picker offers `off` plus the
 * model's own wire rungs (e.g. `low`/`medium`/`high`/`xhigh`/`max`), so the
 * selected id travels verbatim; reasoning models whose schema discloses no
 * ladder offer the budget-only `low`/`high`/`max` vocabulary.
 * @module dsh-llm-kiro/effort
 */

import type { KiroAdditionalModelRequestFields } from './types.ts'

/** The request field the Kiro runtime uses for one model's effort. */
export type KiroEffortField = 'reasoning' | 'output_config'

/** One model's effort ladder and transport, derived from its catalog schema. */
export interface KiroEffortConfig {
  field: KiroEffortField
  values: readonly string[]
  summarizedThinking: boolean
}

/** Every effort rung the Kiro runtime discloses, in ascending order. */
export const KIRO_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** One harness-selectable effort level, or 'off'. */
export type KiroReasoningEffort = 'off' | (typeof KIRO_EFFORT_ORDER)[number]
/** Levels offered for reasoning models whose schema discloses no ladder (thinking budget only). */
export const BUDGET_ONLY_EFFORTS = ['low', 'high', 'max'] as const

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}
/** Wire rungs that disable reasoning rather than select a level; the harness 'off' covers them. */
const DISABLED_EFFORT_VALUES = new Set(['none'])

const GPT_EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_EXTENDED_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_MAX_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const

const CLAUDE_EXTENDED_EFFORT_MODELS = new Set([
  'claude-opus-5.5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-sonnet-5.5',
  'claude-sonnet-5',
  'claude-fable-5',
])
const CLAUDE_MAX_EFFORT_MODELS = new Set([
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-opus-4.6-1m',
  'claude-sonnet-4.6-1m',
])

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Derive the effort ladder and transport from an authenticated catalog
 * schema, when the schema discloses them.
 * @param schema - the model's additionalModelRequestFields schema.
 * @returns the effort config, or undefined when the schema has none.
 */
export function deriveKiroEffort(schema: unknown): KiroEffortConfig | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined

  for (const field of ['reasoning', 'output_config'] as const) {
    const fieldSchema = schema.properties[field]
    if (!isRecord(fieldSchema) || !isRecord(fieldSchema.properties)) continue

    const effortSchema = fieldSchema.properties.effort
    if (!isRecord(effortSchema) || !Array.isArray(effortSchema.enum) || effortSchema.enum.length === 0) continue
    if (!effortSchema.enum.every(value => typeof value === 'string' && value.length > 0)) continue

    const thinkingSchema = schema.properties.thinking
    const displaySchema =
      isRecord(thinkingSchema) && isRecord(thinkingSchema.properties) ? thinkingSchema.properties.display : undefined
    const summarizedThinking =
      isRecord(displaySchema) && Array.isArray(displaySchema.enum) && displaySchema.enum.includes('summarized')

    return { field, values: [...new Set(effortSchema.enum as string[])], summarizedThinking }
  }
  return undefined
}

/**
 * Known-model ladder used before catalog metadata is available. Only the
 * models this provider ships know their ladder ahead of discovery; everything
 * else waits for the authenticated schema.
 * @param kiroModelId - the wire model id.
 * @returns the effort config, or undefined for an unknown model.
 */
export function fallbackKiroEffort(kiroModelId: string): KiroEffortConfig | undefined {
  const normalizedId = kiroModelId.toLowerCase().replace(/(\d)-(\d)/g, '$1.$2')
  if (normalizedId.startsWith('openai-gpt') || normalizedId.startsWith('gpt-')) {
    return { field: 'reasoning', values: GPT_EFFORT_VALUES, summarizedThinking: false }
  }
  if (CLAUDE_EXTENDED_EFFORT_MODELS.has(normalizedId)) {
    return { field: 'output_config', values: CLAUDE_EXTENDED_EFFORT_VALUES, summarizedThinking: true }
  }
  if (CLAUDE_MAX_EFFORT_MODELS.has(normalizedId)) {
    return { field: 'output_config', values: CLAUDE_MAX_EFFORT_VALUES, summarizedThinking: false }
  }
  return undefined
}

/**
 * The effort config for one model: the catalog schema wins, the known-model
 * fallback fills in only its absence.
 * @param schema - the authenticated schema, when available.
 * @param kiroModelId - the wire model id.
 * @returns the effort config, or undefined when nothing discloses a ladder.
 */
export function getKiroEffortConfig(schema: unknown, kiroModelId: string): KiroEffortConfig | undefined {
  if (schema !== undefined) return deriveKiroEffort(schema)
  return fallbackKiroEffort(kiroModelId)
}

/**
 * Display label for one effort rung.
 * @param effort - the wire effort value.
 * @returns the selector label.
 */
export function kiroEffortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Rank of one rung in {@link KIRO_EFFORT_ORDER}; unknown rungs sort last. */
function effortRank(effort: string): number {
  const index = KIRO_EFFORT_ORDER.indexOf(effort as (typeof KIRO_EFFORT_ORDER)[number])
  return index < 0 ? KIRO_EFFORT_ORDER.length : index
}

/**
 * The effort levels the harness picker offers for one model, ascending: the
 * model's own wire rungs minus the reasoning-disabling ones ('off' covers
 * those), or the budget-only ladder when the model discloses none.
 * @param config - the model's effort config, when known.
 * @returns the selectable levels, never empty.
 */
export function selectableKiroEfforts(config: KiroEffortConfig | undefined): readonly string[] {
  const values = config?.values.filter(value => !DISABLED_EFFORT_VALUES.has(value)) ?? []
  if (values.length === 0) return BUDGET_ONLY_EFFORTS
  return [...values].sort((left, right) => effortRank(left) - effortRank(right))
}

/**
 * The rung in `values` matching one effort, rounding up to the next available
 * rung and then down when the exact level is absent.
 * @param effort - the requested effort.
 * @param values - the available rungs.
 * @returns the chosen rung, or undefined when `values` is empty.
 */
export function nearestKiroEffort(effort: string, values: readonly string[]): string | undefined {
  if (values.includes(effort)) return effort
  const targetIndex = KIRO_EFFORT_ORDER.indexOf(effort as (typeof KIRO_EFFORT_ORDER)[number])
  if (targetIndex >= 0) {
    for (let index = targetIndex; index < KIRO_EFFORT_ORDER.length; index++) {
      const candidate = KIRO_EFFORT_ORDER[index]
      if (candidate !== undefined && values.includes(candidate)) return candidate
    }
    for (let index = targetIndex - 1; index >= 0; index--) {
      const candidate = KIRO_EFFORT_ORDER[index]
      if (candidate !== undefined && values.includes(candidate)) return candidate
    }
  }
  return values[0]
}

/**
 * Map a harness effort level to a value present in the model's Kiro enum,
 * rounding to the nearest available rung when the exact level is absent.
 * @param effort - the harness effort (a non-off level).
 * @param config - the model's effort config.
 * @returns the wire effort value, or undefined when the model has no ladder.
 */
export function mapDshEffortToKiro(effort: string, config: KiroEffortConfig): string | undefined {
  return nearestKiroEffort(effort, config.values.filter(value => !DISABLED_EFFORT_VALUES.has(value)))
}

/**
 * Build the top-level Kiro runtime field for one requested harness effort.
 * @param config - the model's effort config.
 * @param effort - the harness effort.
 * @returns the wire fields, or undefined when nothing maps.
 */
export function buildKiroAdditionalModelRequestFields(
  config: KiroEffortConfig | undefined,
  effort: string | undefined,
): KiroAdditionalModelRequestFields | undefined {
  if (!effort || !config) return undefined
  const wireEffort = mapDshEffortToKiro(effort, config)
  if (!wireEffort) return undefined

  return config.field === 'output_config'
    ? {
        output_config: { effort: wireEffort },
        thinking: {
          type: 'adaptive',
          ...(config.summarizedThinking ? { display: 'summarized' as const } : {}),
        },
      }
    : { reasoning: { effort: wireEffort } }
}
