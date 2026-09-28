/**
 * Reasoning-effort tests: the pre-discovery fallback ladders, the schema-first
 * derivation, and the mapping of harness effort onto a model's wire enum.
 */
import { describe, expect, it } from 'vitest'
import {
  buildKiroAdditionalModelRequestFields,
  deriveKiroEffort,
  fallbackKiroEffort,
  getKiroEffortConfig,
  mapDshEffortToKiro,
} from '../src/effort.ts'

describe('llm-kiro effort', () => {
  it('knows the shipped model ladders before discovery', () => {
    expect(fallbackKiroEffort('claude-opus-5.5')).toEqual({
      field: 'output_config',
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      summarizedThinking: true,
    })
    expect(fallbackKiroEffort('claude-opus-5')).toMatchObject({ field: 'output_config', summarizedThinking: true })
    expect(fallbackKiroEffort('gpt-5.6-sol')).toMatchObject({ field: 'reasoning', summarizedThinking: false })
    expect(fallbackKiroEffort('gpt-5.6-terra')).toMatchObject({ field: 'reasoning' })
    expect(fallbackKiroEffort('claude-opus-4.6')).toMatchObject({
      field: 'output_config',
      values: ['low', 'medium', 'high', 'max'],
      summarizedThinking: false,
    })
    expect(fallbackKiroEffort('claude-haiku-4.5')).toBeUndefined()
  })

  it('prefers the authenticated schema and falls back only in its absence', () => {
    const schema = {
      properties: {
        output_config: { properties: { effort: { enum: ['low', 'high'] } } },
        thinking: { properties: { display: { enum: ['summarized'] } } },
      },
    }
    expect(deriveKiroEffort(schema)).toEqual({
      field: 'output_config',
      values: ['low', 'high'],
      summarizedThinking: true,
    })
    expect(getKiroEffortConfig(schema, 'claude-haiku-4.5')).toMatchObject({ values: ['low', 'high'] })
    expect(getKiroEffortConfig(undefined, 'claude-opus-5.5')).toMatchObject({ field: 'output_config' })
    expect(deriveKiroEffort('not-a-schema')).toBeUndefined()
    expect(deriveKiroEffort({ properties: { reasoning: { properties: { effort: { enum: [] } } } } })).toBeUndefined()
  })

  it('maps harness effort onto the nearest wire rung and builds the request field', () => {
    const extended = fallbackKiroEffort('claude-opus-5.5')!
    expect(mapDshEffortToKiro('high', extended)).toBe('high')
    expect(mapDshEffortToKiro('max', extended)).toBe('max')
    expect(buildKiroAdditionalModelRequestFields(extended, 'high')).toEqual({
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    const capped = fallbackKiroEffort('claude-opus-4.6')!
    expect(mapDshEffortToKiro('max', capped)).toBe('max')
    expect(buildKiroAdditionalModelRequestFields(fallbackKiroEffort('gpt-5.6-sol'), 'low')).toEqual({
      reasoning: { effort: 'low' },
    })
    expect(buildKiroAdditionalModelRequestFields(undefined, 'high')).toBeUndefined()
    expect(buildKiroAdditionalModelRequestFields(extended, undefined)).toBeUndefined()
  })
})
