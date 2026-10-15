/**
 * `KiroAdapter`: fetch + AWS event-stream against the Kiro runtime endpoint,
 * emitting harness StreamChunks. Like the DeepSeek adapter, it is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the credential through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 * @module dsh-llm-kiro/adapter
 */

import {
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageBlock,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  LlmModelReasoningInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  ContentBlock,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { getKiroEndpoints, resolveApiRegion } from './endpoints.ts'
import {
  buildKiroAdditionalModelRequestFields,
  kiroEffortLabel,
  nearestKiroEffort,
  selectableKiroEfforts,
  type KiroReasoningEffort,
} from './effort.ts'
import { kiroEffortFor, resolveKiroModelId, servedKiroModels } from './models.ts'
import type { KiroModel } from './models.ts'
import { resolveKiroProfileArn, KiroManagementHttpError } from './management.ts'
import { serializeKiroRequest, type EncodedKiroImage } from './serialize.ts'
import { streamKiroEvents } from './stream.ts'
import { translate } from './translate.ts'
import type { KiroCredentials } from './types.ts'
import type { KiroStorePaths } from './kiro-cli.ts'

/** Default maximum idle interval while one adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 8_192
/** Default first-event timeout for models without a longer one. */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 90_000

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const OFF_ONLY_REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
] as const

/** Thinking budget (max_thinking_length marker) per effort level; unknown levels use the high budget. */
const THINKING_BUDGET: Readonly<Record<string, number>> = {
  low: 10_000,
  medium: 20_000,
  high: 30_000,
  xhigh: 40_000,
  max: 50_000,
}
const DEFAULT_THINKING_BUDGET = 30_000

/** Validated connection facts for one operation; produced by the plugin's resolve step. */
export interface KiroConnectionOptions {
  /** Kiro API region override; the credential's region wins when unset. */
  region?: string
  /** Runtime endpoint override (gateway/proxy deployments); defaults to the region's kiro.dev endpoint. */
  runtimeURL?: string
  /** Profile ARN override; the credential's or management discovery wins when unset. */
  profileArn?: string
  /**
   * Optional credential reference for a static bearer token. When set, the
   * ambient kiro-cli / Kiro IDE discovery is skipped entirely and the
   * referenced secret authenticates every request.
   */
  bearerTokenEnv?: CredentialRef
  /** Configured models, or the bootstrap catalog when nothing was configured. */
  models: readonly KiroModel[]
  /**
   * Whether the authenticated catalog may refresh and extend {@link models}.
   * The plugin sets this when the user configured no explicit model list; an
   * explicit list stays authoritative and is served verbatim.
   */
  discoverModels?: boolean
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Deployment thinking policy; 'disabled' limits every conversation request to off. */
  thinking: 'enabled' | 'disabled'
  /** Default reasoning effort; 'off' disables thinking, other levels round to each model's ladder. */
  reasoningEffort: KiroReasoningEffort
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum time to the first stream event. */
  firstTokenTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
  /** Credential store path overrides for ambient discovery. */
  kiroStorePaths?: KiroStorePaths
  /** Whether 403 recovery may shell out to kiro-cli. */
  allowKiroCliRefresh: boolean
  /** Capacity-retry delay override, forwarded to the transport (tests and tuning). */
  capacityDelayMs?: (attempt: number) => number
}

/** Constructor options for {@link KiroAdapter}: the operation-local resolution hooks the plugin owns. */
export interface KiroAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => KiroConnectionOptions
  /**
   * Resolve the credential for one request: ambient kiro-cli / Kiro IDE
   * pickup with silent refresh, or the configured bearer reference. Throws
   * LlmError MISSING_CREDENTIAL when nothing is available.
   */
  resolveCredential: (connection: KiroConnectionOptions) => Promise<KiroCredentials>
  /**
   * Recover a credential after the runtime rejected one with 403: re-read the
   * shared store, then refresh. Returns undefined when nothing new is found.
   */
  recoverCredential: (
    rejected: KiroCredentials,
    connection: KiroConnectionOptions,
  ) => Promise<KiroCredentials | undefined>
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Kick a background refresh of the shared authenticated catalog. Called when
   * the harness reads the model list; the plugin coalesces concurrent calls
   * and swallows failures so a provider outage never breaks the picker.
   */
  warmCatalog?: (connection: KiroConnectionOptions) => void
}

/** The Kiro provider route name. */
export const PROVIDER = 'kiro'

/** Every image block in one block list, including tool-result nesting. */
function imageBlocks(blocks: readonly ContentBlock[]): ImageBlock[] {
  const images: ImageBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') images.push(block)
    else if (block.type === 'tool-result') images.push(...imageBlocks(block.content))
  }
  return images
}

function modelInfo(provider: string, model: KiroModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.inputModalities,
  }
}

/**
 * The effort picker for one model: 'off' plus the model's own Kiro rungs, with
 * the configured default rounded onto that ladder.
 */
function reasoningInfo(connection: KiroConnectionOptions, model: KiroModel | undefined): LlmModelReasoningInfo {
  if (connection.thinking === 'disabled' || model?.reasoning !== true) {
    return { efforts: OFF_ONLY_REASONING_EFFORTS, defaultEffort: OFF_REASONING_EFFORT }
  }
  const levels = selectableKiroEfforts(kiroEffortFor(model.kiroModelId, model.additionalModelRequestFieldsSchema))
  const defaultLevel = connection.reasoningEffort === 'off'
    ? undefined
    : nearestKiroEffort(connection.reasoningEffort, levels)
  return {
    efforts: [
      ...OFF_ONLY_REASONING_EFFORTS,
      ...levels.map(level => ({ id: ReasoningEffortId(level), name: kiroEffortLabel(level) })),
    ],
    defaultEffort: defaultLevel === undefined ? OFF_REASONING_EFFORT : ReasoningEffortId(defaultLevel),
  }
}

/** The model metadata for one exact model id: catalog entry or undefined. */
function catalogEntry(models: readonly KiroModel[], model: string): KiroModel | undefined {
  return models.find(entry => entry.id === model)
}

/**
 * The Kiro adapter: one instance serves every model id under the `kiro`
 * provider route.
 */
export class KiroAdapter extends LlmAdapter {
  constructor(private readonly config: KiroAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kiro' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options()
    // Reading the list is the natural pull point for the catalog: serve the
    // cache immediately and refresh it in the background for the next read.
    this.config.warmCatalog?.(connection)
    return Promise.resolve(servedKiroModels(connection).map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = catalogEntry(servedKiroModels(connection), model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: reasoningInfo(connection, configured),
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      const model = catalogEntry(servedKiroModels(connection), options.model)
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `Kiro model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          'Kiro image conversion requires the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      attachments,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Kiro request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('Kiro API stream failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Kiro stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: KiroConnectionOptions,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    // One credential resolution per stream call; an in-flight stream never
    // observes a configuration change and the next call re-resolves.
    let credential = await this.config.resolveCredential(connection)
    // The credential region is the SSO region the token was minted in; the
    // Kiro API region that serves it may differ (eu-west-1 -> eu-central-1),
    // so every management and runtime endpoint derives from the resolved one.
    const region = resolveApiRegion(credential.region ?? connection.region)
    let wireModelId: string
    try {
      wireModelId = resolveKiroModelId(options.model)
    } catch (error) {
      throw new LlmError(`llm-kiro: ${(error as Error).message}`, 'INVALID_REQUEST', { cause: error })
    }
    const model = catalogEntry(servedKiroModels(connection), options.model)
    const contextWindow = model?.contextWindow ?? connection.defaultContextWindow
    const effortConfig = kiroEffortFor(wireModelId, model?.additionalModelRequestFieldsSchema)
    const effectiveEffort: string = options.reasoningEffort ?? connection.reasoningEffort
    const thinkingEnabled = effectiveEffort !== 'off'
      && connection.thinking !== 'disabled'
      && (model?.reasoning ?? true)

    let system = options.system ?? ''
    if (thinkingEnabled) {
      const budget = THINKING_BUDGET[effectiveEffort] ?? DEFAULT_THINKING_BUDGET
      system = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${system ? `\n${system}` : ''}`
    }

    // Images resolve through the attachment store; their bytes travel as
    // base64 payloads on the current message. History images are stripped by
    // the serializer, so only current-message blocks are read.
    let encodedImages: Map<string, EncodedKiroImage> | undefined
    if (attachments !== undefined) {
      encodedImages = new Map()
      for (const message of options.messages) {
        for (const block of imageBlocks(message.content)) {
          const stored = await attachments.readImage(block.attachment, signal)
          encodedImages.set(block.attachment.attachmentId, {
            mediaType: stored.ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
          })
        }
      }
    }

    const body = serializeKiroRequest(options, wireModelId, system || undefined, contextWindow, encodedImages)
    const additionalModelRequestFields = buildKiroAdditionalModelRequestFields(
      effortConfig,
      thinkingEnabled ? effectiveEffort : undefined,
    )
    if (additionalModelRequestFields) body.additionalModelRequestFields = additionalModelRequestFields

    let profileArn = connection.profileArn ?? credential.profileArn
    if (!profileArn) {
      try {
        profileArn = await resolveKiroProfileArn({ accessToken: credential.access, region })
      } catch (error) {
        if (error instanceof KiroManagementHttpError && error.status === 403 && connection.allowKiroCliRefresh) {
          const recovered = await this.config.recoverCredential(credential, connection)
          if (recovered) {
            credential = recovered
            profileArn = await resolveKiroProfileArn({ accessToken: recovered.access, region })
          } else {
            throw error
          }
        } else {
          throw error
        }
      }
    }

    let attempt = 0
    while (true) {
      attempt++
      try {
        const events = streamKiroEvents({
          request: { ...body, profileArn },
          credential,
          profileArn,
          firstTokenTimeoutMs: model?.firstTokenTimeoutMs ?? connection.firstTokenTimeoutMs,
          signal,
          ...(connection.capacityDelayMs !== undefined ? { capacityDelayMs: connection.capacityDelayMs } : {}),
          endpoint: connection.runtimeURL
            ?? new URL('generateAssistantResponse', getKiroEndpoints(region).runtime).toString(),
        })
        onActivity()
        yield* translate(events, contextWindow)
        return
      } catch (error: unknown) {
        const auth403 = error instanceof LlmError && error.failure.status === 403
        if (!auth403 || attempt >= 2 || !connection.allowKiroCliRefresh) throw error
        const recovered = await this.config.recoverCredential(credential, connection)
        if (!recovered || recovered.access === credential.access) throw error
        credential = recovered
        // The profile may belong to the rejected credential generation.
        profileArn = connection.profileArn ?? recovered.profileArn ?? profileArn
      }
    }
  }
}