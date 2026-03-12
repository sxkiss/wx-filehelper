import { randomUUID } from 'node:crypto';
import type { OutboundMediaInput, WxFileHelperConfig, WxFileHelperInboundMessage } from './channel';
import { WxFileHelperChannel } from './channel';

/**
 * @input WxFileHelperChannel 与 OpenClaw runtime(channel.routing/reply/session/text) 接口
 * @output wxFileHelperPlugin 与默认插件导出，提供轮询入站与文本/媒体出站能力
 * @position wx-filehelper 插件编排层，负责账号生命周期、会话分发与消息回送
 * @auto-doc Update header and folder INDEX.md when this file changes
 */

const DEFAULT_ACCOUNT_ID = 'default';
const CHANNEL_ID = 'wx-filehelper';
const KNOWN_CHANNEL_PREFIXES = ['dingtalk:', 'feishu:', 'wecom:', 'qq:', 'telegram:', 'discord:', 'slack:'];

type RouteResult = {
  sessionKey: string;
  accountId: string;
  agentId?: string;
};

type PollRunner = {
  stopRequested: boolean;
  cancelSleep?: () => void;
  promise: Promise<void>;
};

type ParsedTarget = {
  accountId?: string;
  to: string;
};

type OutboundMediaMessageType = 'image' | 'voice' | 'audio' | 'video' | 'file';

const runnersByAccountId = new Map<string, PollRunner>();
const channelsByAccountId = new Map<string, WxFileHelperChannel>();
let runtimeFromRegister: any = null;

const meta = {
  id: CHANNEL_ID,
  label: 'Wx FileHelper',
  selectionLabel: 'Wx FileHelper (微信文件传输助手)',
  docsPath: '/channels/wx-filehelper',
  docsLabel: 'wx-filehelper',
  blurb: '基于 wx-filehelper-api 的文本/媒体双向通信插件',
  aliases: ['wx', 'wx-filehelper-api'],
  order: 87,
} as const;

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return {};
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function resolveOutboundMediaMessageType(value: string): OutboundMediaMessageType | null {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image') {
    return 'image';
  }
  if (normalized === 'voice') {
    return 'voice';
  }
  if (normalized === 'audio') {
    return 'audio';
  }
  if (normalized === 'video') {
    return 'video';
  }
  if (normalized === 'file' || !normalized) {
    return 'file';
  }
  return null;
}

function resolveDefaultMediaExtension(type: OutboundMediaMessageType): string {
  if (type === 'image') {
    return '.jpg';
  }
  if (type === 'voice' || type === 'audio') {
    return '.amr';
  }
  if (type === 'video') {
    return '.mp4';
  }
  return '.bin';
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

function extractErrorCode(message: string): string {
  const matched = String(message).match(/\b(\d{3,6})\b/);
  return matched?.[1] ?? '';
}

function trySetStatusFromParams(params: any, accountId: string, patch: Record<string, unknown>): void {
  const setStatus =
    typeof params?.setStatus === 'function'
      ? params.setStatus
      : typeof params?.ctx?.setStatus === 'function'
        ? params.ctx.setStatus
        : null;

  if (!setStatus) {
    return;
  }

  try {
    setStatus({ accountId, ...patch });
  } catch {
    return;
  }
}

function parseTarget(input: string): ParsedTarget | null {
  const rawTarget = normalizeString(input);
  if (!rawTarget) {
    return null;
  }

  let raw = rawTarget;
  if (raw.startsWith(`${CHANNEL_ID}:`)) {
    raw = raw.slice(`${CHANNEL_ID}:`.length);
  }

  let accountId: string | undefined;
  let to = raw;

  const atIndex = raw.lastIndexOf('@');
  if (atIndex > 0 && atIndex < raw.length - 1) {
    const candidate = raw.slice(atIndex + 1);
    if (!candidate.includes(':') && !candidate.includes('/')) {
      accountId = candidate;
      to = raw.slice(0, atIndex);
    }
  }

  if (to.startsWith('group:')) {
    const id = normalizeString(to.slice('group:'.length));
    return id ? { accountId, to: `group:${id}` } : null;
  }

  if (to.startsWith('user:')) {
    const id = normalizeString(to.slice('user:'.length));
    return id ? { accountId, to: `user:${id}` } : null;
  }

  if (to.startsWith('chat:')) {
    const id = normalizeString(to.slice('chat:'.length));
    return id ? { accountId, to: `chat:${id}` } : null;
  }

  const fallback = normalizeString(to);
  return fallback ? { accountId, to: `user:${fallback}` } : null;
}

function stripChannelPrefix(raw: string): string {
  if (raw.startsWith(`${CHANNEL_ID}:`)) {
    return raw.slice(`${CHANNEL_ID}:`.length);
  }
  return raw;
}

function normalizeChatIdForApi(raw: string | undefined): string {
  const value = normalizeString(raw);
  if (!value) {
    return '';
  }

  let resolved = stripChannelPrefix(value);
  if (resolved.startsWith('group:')) {
    resolved = resolved.slice('group:'.length);
  } else if (resolved.startsWith('user:')) {
    resolved = resolved.slice('user:'.length);
  } else if (resolved.startsWith('chat:')) {
    resolved = resolved.slice('chat:'.length);
  }

  if (resolved.endsWith('@chatroom')) {
    resolved = resolved.slice(0, -9);
  }

  // wx-filehelper-api 的 getUpdates 在某些情况下不带 chat_id，
  // 我们会用 'unknown' 作为占位。发送时不能把它当作真实 chat_id。
  const normalized = normalizeString(resolved);
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return '';
  }

  return normalized;
}

function getRuntime(ctx: any): any {
  if (ctx?.runtime?.channel) {
    return ctx.runtime;
  }

  if (runtimeFromRegister?.channel) {
    return runtimeFromRegister;
  }

  return ctx?.runtime ?? runtimeFromRegister ?? null;
}

function extractMediaCandidatesFromText(text: string): string[] {
  const value = normalizeString(text);
  if (!value) {
    return [];
  }

  const result: string[] = [];
  const append = (candidate: unknown): void => {
    const normalized = normalizeString(candidate);
    if (!normalized) {
      return;
    }
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  };

  const markdownPattern = /!\[[^\]]*]\(([^)]+)\)/g;
  const bracketPattern = /\[(?:image|图片|file|文件)]\s*(https?:\/\/[^\s)]+|\/[^\s)]+)/gi;
  const directivePattern = /^\s*MEDIA:(.+)$/gim;

  let match: RegExpExecArray | null;
  while ((match = markdownPattern.exec(value)) !== null) {
    append(match[1]);
  }

  while ((match = bracketPattern.exec(value)) !== null) {
    append(match[1]);
  }

  while ((match = directivePattern.exec(value)) !== null) {
    append(match[1]);
  }

  return result;
}

function stripMediaDirectives(text: string): string {
  return text
    .replace(/!\[[^\]]*]\(([^)]+)\)/g, '')
    .replace(/\[(?:image|图片|file|文件)]\s*(https?:\/\/[^\s)]+|\/[^\s)]+)/gi, '')
    .replace(/^\s*MEDIA:.+$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMediaCandidatesFromReplyPayload(payload: Record<string, unknown>): string[] {
  const result: string[] = [];
  const append = (value: unknown): void => {
    const normalized = normalizeString(value);
    if (!normalized) {
      return;
    }
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  };

  append(payload.mediaUrl);
  append(payload.mediaPath);

  const mediaUrls = Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [];
  for (const value of mediaUrls) {
    append(value);
  }

  const mediaPaths = Array.isArray(payload.mediaPaths) ? payload.mediaPaths : [];
  for (const value of mediaPaths) {
    append(value);
  }

  const media = payload.media;
  if (typeof media === 'string') {
    append(media);
  }

  return result;
}

function buildInboundRawBody(message: WxFileHelperInboundMessage, mediaCount = message.mediaCandidates.length): string {
  if (mediaCount <= 0) {
    return message.text;
  }

  const mediaLine = mediaCount === 1 ? '[media attached]' : `[media attached: ${mediaCount}]`;
  return [message.text, mediaLine].filter(Boolean).join('\n');
}

function resolveInboundMediaExtension(type: WxFileHelperInboundMessage['type']): string {
  if (type === 'image') {
    return '.jpg';
  }
  if (type === 'voice') {
    return '.amr';
  }
  if (type === 'video') {
    return '.mp4';
  }
  return '.bin';
}

function pickActiveChannel(accountId: string): WxFileHelperChannel | null {
  const direct = channelsByAccountId.get(accountId);
  if (direct) {
    return direct;
  }

  const first = channelsByAccountId.values().next();
  if (first.done) {
    return null;
  }

  return first.value;
}

function resolveOutboundMediaInput(
  params: Record<string, unknown>,
  payload: Record<string, unknown>,
): OutboundMediaInput | null {
  const mediaPath = normalizeString(params.mediaPath || payload.mediaPath || payload.path);
  if (mediaPath) {
    return { kind: 'path', value: mediaPath, filename: normalizeString(params.filename || payload.filename) };
  }

  const mediaUrl = normalizeString(params.mediaUrl || payload.mediaUrl || payload.url);
  if (mediaUrl) {
    return { kind: 'url', value: mediaUrl, filename: normalizeString(params.filename || payload.filename) };
  }

  const mediaBase64 = normalizeString(params.base64 || params.mediaBase64 || payload.base64);
  if (mediaBase64) {
    return { kind: 'base64', value: mediaBase64, filename: normalizeString(params.filename || payload.filename) };
  }

  const media = params.media ?? payload.media;
  if (typeof media === 'string') {
    if (media.startsWith('http://') || media.startsWith('https://')) {
      return { kind: 'url', value: media, filename: normalizeString(params.filename || payload.filename) };
    }
    if (media.startsWith('data:')) {
      return { kind: 'base64', value: media, filename: normalizeString(params.filename || payload.filename) };
    }
    return { kind: 'path', value: media, filename: normalizeString(params.filename || payload.filename) };
  }

  if (media && typeof media === 'object' && !Array.isArray(media)) {
    const record = media as Record<string, unknown>;
    const kind = normalizeString(record.kind).toLowerCase();
    const value = normalizeString(record.value);
    if (kind && value && ['path', 'url', 'base64'].includes(kind)) {
      return {
        kind: kind as 'path' | 'url' | 'base64',
        value,
        filename: normalizeString(record.filename || params.filename || payload.filename),
      };
    }
  }

  return null;
}

async function deliverMediaCandidates(params: {
  channel: WxFileHelperChannel;
  chatId?: string;
  candidates: string[];
  caption?: string;
  logger?: { warn?: (message: string) => void };
}): Promise<number> {
  let sentCount = 0;

  for (const candidate of params.candidates) {
    const materialized = await params.channel.materializeOutboundMedia(candidate, '.jpg');
    if (!materialized) {
      continue;
    }

    try {
      const mediaMethod = params.channel.resolveMediaMethod(materialized);
      const chatIdForSend = params.chatId || undefined;
      if (mediaMethod === 'photo') {
        await params.channel.sendPhoto(chatIdForSend, materialized, params.caption);
      } else {
        await params.channel.sendDocument(chatIdForSend, materialized, params.caption);
      }
      sentCount += 1;
    } catch (error) {
      params.logger?.warn?.(`[wx-filehelper] 发送媒体失败: ${String(error)}`);
    }
  }

  return sentCount;
}

function createRunnerSleep(runner: PollRunner, milliseconds: number): Promise<void> {
  if (runner.stopRequested || milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      runner.cancelSleep = undefined;
      resolve();
    }, milliseconds);

    runner.cancelSleep = () => {
      clearTimeout(timeout);
      runner.cancelSleep = undefined;
      resolve();
    };
  });
}

async function dispatchInboundMessage(params: {
  ctx: any;
  accountId: string;
  channel: WxFileHelperChannel;
  inbound: WxFileHelperInboundMessage;
}): Promise<void> {
  const { ctx, accountId, channel, inbound } = params;
  const core = getRuntime(ctx);
  const channelApi = core?.channel;

  if (!channelApi?.routing?.resolveAgentRoute || !channelApi?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    ctx.log?.warn?.('[wx-filehelper] runtime routing/reply API 不可用，跳过分发');
    return;
  }

  const peerKind = inbound.chatType === 'group' ? 'group' : 'direct';
  const route = channelApi.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    peer: {
      kind: peerKind,
      id: inbound.chatId,
    },
  }) as RouteResult;

  const normalizedMediaCandidates = inbound.mediaCandidates.map((item) => normalizeString(item)).filter(Boolean);
  const mediaUrls = normalizedMediaCandidates.filter(
    (item) => item.startsWith('http://') || item.startsWith('https://') || item.startsWith('data:'),
  );
  const candidateMediaPaths = normalizedMediaCandidates.filter(
    (item) =>
      !item.startsWith('http://') &&
      !item.startsWith('https://') &&
      !item.startsWith('data:') &&
      (item.includes('/') || item.includes('\\') || item.startsWith('~')),
  );
  const materializedMediaPaths: string[] = [];
  const inboundMediaExtension = resolveInboundMediaExtension(inbound.type);
  for (const candidate of normalizedMediaCandidates) {
    const materialized = await channel.materializeOutboundMedia(candidate, inboundMediaExtension);
    const normalized = normalizeString(materialized);
    if (!normalized) {
      continue;
    }
    if (!materializedMediaPaths.includes(normalized)) {
      materializedMediaPaths.push(normalized);
    }
  }
  const mediaPaths = materializedMediaPaths.length > 0 ? materializedMediaPaths : candidateMediaPaths;
  const mediaAttachmentCount = mediaPaths.length > 0 ? mediaPaths.length : mediaUrls.length;
  const rawBody = buildInboundRawBody(inbound, mediaAttachmentCount);
  const fromLabel = `${inbound.chatType}:${inbound.chatId}`;

  const storePath = channelApi.session?.resolveStorePath?.(ctx.cfg?.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = channelApi.session?.readSessionUpdatedAt
    ? channelApi.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? undefined
    : undefined;

  const envelopeOptions = channelApi.reply?.resolveEnvelopeFormatOptions
    ? channelApi.reply.resolveEnvelopeFormatOptions(ctx.cfg)
    : undefined;

  const body = channelApi.reply?.formatAgentEnvelope
    ? channelApi.reply.formatAgentEnvelope({
        channel: 'Wx FileHelper',
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      })
    : rawBody;

  const from = `${CHANNEL_ID}:${inbound.chatType === 'group' ? 'group' : 'user'}:${inbound.senderId}`;
  const to = `${inbound.chatType === 'group' ? 'group' : 'user'}:${inbound.chatId}`;
  const mediaType = inbound.type !== 'text' && inbound.type !== 'unknown' ? inbound.type : undefined;
  const preferredMediaPaths = mediaPaths;
  const preferredMediaUrls = preferredMediaPaths.length > 0 ? [] : mediaUrls;
  const firstMediaPath = preferredMediaPaths[0];
  const firstMediaUrl = preferredMediaUrls[0];
  const mediaItemCount = preferredMediaPaths.length > 0 ? preferredMediaPaths.length : preferredMediaUrls.length;
  const mediaTypes = mediaType && mediaItemCount > 1 ? Array.from({ length: mediaItemCount }, () => mediaType) : undefined;

  const inboundContext = channelApi.reply?.finalizeInboundContext
    ? channelApi.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: inbound.chatType,
        ConversationLabel: fromLabel,
        SenderName: inbound.senderId,
        SenderId: inbound.senderId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: inbound.messageId,
        MediaUrl: firstMediaUrl,
        MediaUrls: preferredMediaUrls.length > 0 ? preferredMediaUrls : undefined,
        MediaPath: firstMediaPath,
        MediaPaths: preferredMediaPaths.length > 0 ? preferredMediaPaths : undefined,
        MediaType: mediaType,
        MediaTypes: mediaTypes,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: to,
        ChannelData: {
          msgType: inbound.type,
          mediaUrl: firstMediaUrl,
          mediaUrls: mediaUrls,
          mediaPath: firstMediaPath,
          mediaPaths: mediaPaths,
          mediaCandidates: inbound.mediaCandidates,
          raw: inbound.rawUpdate,
        },
      })
    : {
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: inbound.chatType,
        ConversationLabel: fromLabel,
        SenderName: inbound.senderId,
        SenderId: inbound.senderId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: inbound.messageId,
        MediaUrl: firstMediaUrl,
        MediaUrls: preferredMediaUrls.length > 0 ? preferredMediaUrls : undefined,
        MediaPath: firstMediaPath,
        MediaPaths: preferredMediaPaths.length > 0 ? preferredMediaPaths : undefined,
        MediaType: mediaType,
        MediaTypes: mediaTypes,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: to,
        ChannelData: {
          msgType: inbound.type,
          mediaUrl: firstMediaUrl,
          mediaUrls: mediaUrls,
          mediaPath: firstMediaPath,
          mediaPaths: mediaPaths,
          mediaCandidates: inbound.mediaCandidates,
          raw: inbound.rawUpdate,
        },
      };

  if (channelApi.session?.recordInboundSession && storePath) {
    await channelApi.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: inboundContext,
      onRecordError: (error: unknown) => {
        ctx.log?.warn?.(`[wx-filehelper] 记录会话失败: ${String(error)}`);
      },
    });
  }

  const tableMode = channelApi.text?.resolveMarkdownTableMode
    ? channelApi.text.resolveMarkdownTableMode({ cfg: ctx.cfg, channel: CHANNEL_ID, accountId })
    : undefined;

  const chatIdForReply = normalizeChatIdForApi(inbound.chatId);

  await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: inboundContext,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string } & Record<string, unknown>) => {
        const rawText = String(payload?.text ?? '');
        const convertedText = channelApi.text?.convertMarkdownTables && tableMode
          ? channelApi.text.convertMarkdownTables(rawText, tableMode)
          : rawText;

        const mediaCandidates = Array.from(new Set([
          ...extractMediaCandidatesFromReplyPayload(payload),
          ...extractMediaCandidatesFromText(convertedText),
        ].filter(Boolean)));

        if (mediaCandidates.length > 0) {
          const mediaSentCount = await deliverMediaCandidates({
            channel,
            chatId: chatIdForReply,
            candidates: mediaCandidates,
            logger: ctx.log,
          });
          if (mediaSentCount > 0) {
            ctx.setStatus?.({
              accountId,
              lastSendAt: Date.now(),
              lastSendType: 'media',
              lastSendMediaCount: mediaSentCount,
              lastSendChatId: chatIdForReply,
            });
          }
        }

        const textPayload = stripMediaDirectives(convertedText);
        if (!textPayload) {
          return;
        }

        await channel.sendText(chatIdForReply, textPayload);
        ctx.setStatus?.({
          accountId,
          lastOutboundAt: Date.now(),
          lastSendAt: Date.now(),
          lastSendType: 'text',
          lastSendChars: textPayload.length,
          lastSendChatId: chatIdForReply,
        });
      },
      onError: (error: unknown, info: { kind: string }) => {
        const message = toError(error).message;
        ctx.log?.error?.(`[wx-filehelper] ${info.kind} 分发失败: ${message}`);
        ctx.setStatus?.({
          accountId,
          lastSendErrorAt: Date.now(),
          lastSendError: message,
          lastSendErrorCode: extractErrorCode(message) || null,
        });
      },
    },
  });

  ctx.setStatus?.({ accountId, lastInboundAt: Date.now() });
}

async function runPollingLoop(params: {
  accountId: string;
  runner: PollRunner;
  ctx: any;
  channel: WxFileHelperChannel;
}): Promise<void> {
  const { accountId, runner, ctx, channel } = params;
  const recentQueue: string[] = [];
  const recentSet = new Set<string>();
  const dedupLimit = 2000;

  let offset = 0;
  let startupSynced = !channel.skipHistoryOnStart;

  while (!runner.stopRequested) {
    const online = await channel.ensureOnline();
    if (!online) {
      await createRunnerSleep(runner, channel.loginCheckInterval);
      continue;
    }

    if (!startupSynced) {
      try {
        const synced = await channel.syncStartupOffset(offset);
        offset = synced.offset;
        startupSynced = true;
        if (synced.skipped > 0) {
          ctx.log?.warn?.(`[wx-filehelper] 启动去重：已跳过 ${synced.skipped} 条历史更新`);
        }
      } catch (error) {
        ctx.log?.warn?.(`[wx-filehelper] 启动去重失败，回退常规轮询: ${String(error)}`);
        startupSynced = true;
      }
    }

    try {
      const batch = await channel.fetchUpdates(offset);
      offset = batch.nextOffset;
      ctx.setStatus?.({
        accountId,
        lastPollAt: Date.now(),
        lastPollCount: batch.updates.length,
        pollOffset: offset,
      });

      if (batch.updates.length === 0) {
        await createRunnerSleep(runner, channel.pollingInterval);
        continue;
      }

      for (const update of batch.updates) {
        if (runner.stopRequested) {
          break;
        }

        const inbound = await channel.normalizeUpdate(update);
        if (!inbound) {
          continue;
        }

        const dedupKey = `${inbound.chatId}:${inbound.messageId}`;
        if (recentSet.has(dedupKey)) {
          continue;
        }

        recentSet.add(dedupKey);
        recentQueue.push(dedupKey);
        if (recentQueue.length > dedupLimit) {
          const removed = recentQueue.shift();
          if (removed) {
            recentSet.delete(removed);
          }
        }

        await dispatchInboundMessage({
          ctx,
          accountId,
          channel,
          inbound,
        });
      }
    } catch (error) {
      const message = toError(error).message;
      ctx.setStatus?.({
        accountId,
        lastPollErrorAt: Date.now(),
        lastPollError: message,
        lastPollErrorCode: extractErrorCode(message) || null,
      });
      if (message.includes('UNAUTHORIZED:')) {
        ctx.log?.warn?.(`[wx-filehelper] API 返回未登录: ${message}`);
        await createRunnerSleep(runner, channel.loginCheckInterval);
      } else {
        ctx.log?.error?.(`[wx-filehelper] 轮询失败: ${message}`);
        await createRunnerSleep(runner, channel.pollingInterval);
      }
    }
  }
}

async function stopRunner(accountId: string): Promise<void> {
  const runner = runnersByAccountId.get(accountId);
  if (!runner) {
    return;
  }

  runner.stopRequested = true;
  runner.cancelSleep?.();

  try {
    await runner.promise;
  } catch {
    // ignore
  }

  runnersByAccountId.delete(accountId);
}

const wxFileHelperPlugin = {
  id: CHANNEL_ID,

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ['direct', 'group'] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
  },

  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' },
      name: { type: 'string' },
      baseUrl: { type: 'string' },
      requestTimeout: { type: 'number' },
      pollingTimeout: { type: 'number' },
      pollingLimit: { type: 'number' },
      pollingInterval: { type: 'number' },
      loginAutoPoll: { type: 'boolean' },
      loginCheckInterval: { type: 'number' },
      qrRefreshInterval: { type: 'number' },
      skipHistoryOnStart: { type: 'boolean' },
      startupSyncLimit: { type: 'number' },
      qrSavePath: { type: 'string' },
      mediaCacheDir: { type: 'string' },
      defaultChatId: { type: 'string' },
    },
  },

  reload: { configPrefixes: ['channels.wx-filehelper'] },

  config: {
    listAccountIds: (): string[] => [DEFAULT_ACCOUNT_ID],

    resolveAccount: (cfg: any, accountId?: string) => {
      const config = (cfg?.channels?.[CHANNEL_ID] ?? {}) as WxFileHelperConfig;
      return {
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        name: config.name ?? 'Wx FileHelper',
        enabled: config.enabled !== false,
        configured: true,
        config,
      };
    },

    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    isConfigured: (): boolean => true,

    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: normalizeString(account?.config?.baseUrl || 'http://127.0.0.1:8000'),
    }),
  },

  directory: {
    canResolve: (params: { target: string }): boolean => {
      const raw = normalizeString(params.target);
      if (!raw) {
        return false;
      }

      if (raw.startsWith(`${CHANNEL_ID}:`)) {
        return true;
      }

      for (const prefix of KNOWN_CHANNEL_PREFIXES) {
        if (raw.startsWith(prefix)) {
          return false;
        }
      }

      return false;
    },

    resolveTarget: (params: { target: string }) => {
      const parsed = parseTarget(params.target);
      if (!parsed) {
        return null;
      }

      return {
        channel: CHANNEL_ID,
        to: parsed.to,
        accountId: parsed.accountId,
      };
    },

    resolveTargets: (params: { targets: string[] }) => {
      return params.targets
        .map((target) => wxFileHelperPlugin.directory.resolveTarget({ target }))
        .filter(Boolean) as Array<{ channel: string; to: string; accountId?: string }>;
    },

    getTargetFormats: (): string[] => [
      'wx-filehelper:user:<chatId>',
      'wx-filehelper:group:<chatId>',
      'wx-filehelper:chat:<chatId>',
      'wx-filehelper:<chatId>',
    ],
  },

  outbound: {
    deliveryMode: 'direct' as const,

    sendText: async (params: any) => {
      const accountId = normalizeString(params.accountId || DEFAULT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
      const channel = pickActiveChannel(accountId);
      if (!channel) {
        return {
          channel: CHANNEL_ID,
          ok: false,
          messageId: '',
          error: new Error('channel not initialized'),
        };
      }

      try {
        const payload = parseJsonObject(params.payload);
        const mediaInput = resolveOutboundMediaInput(params as Record<string, unknown>, payload);
        if (mediaInput) {
          return wxFileHelperPlugin.outbound.sendMedia(params);
        }
        const text = normalizeString(params.text || payload.text || payload.content || '');
        const chatId = normalizeChatIdForApi(params.to || params.chatId || payload.chat_id || payload.chatId || channel.defaultChatId);

        await channel.sendText(chatId || undefined, text || '[空消息]');
        trySetStatusFromParams(params, accountId, {
          lastSendAt: Date.now(),
          lastSendType: 'text',
          lastSendChatId: chatId,
          lastSendChars: (text || '[空消息]').length,
        });

        return {
          channel: CHANNEL_ID,
          ok: true,
          messageId: randomUUID(),
        };
      } catch (error) {
        const resolvedError = toError(error);
        trySetStatusFromParams(params, accountId, {
          lastSendErrorAt: Date.now(),
          lastSendError: resolvedError.message,
          lastSendErrorCode: extractErrorCode(resolvedError.message) || null,
        });
        return {
          channel: CHANNEL_ID,
          ok: false,
          messageId: '',
          error: resolvedError,
        };
      }
    },

    sendMedia: async (params: any) => {
      const accountId = normalizeString(params.accountId || DEFAULT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
      const channel = pickActiveChannel(accountId);
      if (!channel) {
        return {
          channel: CHANNEL_ID,
          ok: false,
          messageId: '',
          error: new Error('channel not initialized'),
        };
      }

      try {
        const payload = parseJsonObject(params.payload);
        const requestedMsgType = normalizeString(params.msgtype || payload.msgtype || 'image').toLowerCase();
        const msgType = resolveOutboundMediaMessageType(requestedMsgType);
        const chatId = normalizeChatIdForApi(params.to || params.chatId || payload.chat_id || payload.chatId || channel.defaultChatId);
        const caption = normalizeString(params.caption || params.text || payload.caption || payload.text || '');

        if (!msgType) {
          return {
            channel: CHANNEL_ID,
            ok: false,
            messageId: '',
            error: new Error(`unsupported msgtype: ${requestedMsgType}`),
          };
        }

        const mediaInput = resolveOutboundMediaInput(params as Record<string, unknown>, payload);
        if (!mediaInput) {
          if (caption) {
            await channel.sendText(chatId, caption);
            return {
              channel: CHANNEL_ID,
              ok: true,
              messageId: randomUUID(),
            };
          }

          return {
            channel: CHANNEL_ID,
            ok: false,
            messageId: '',
            error: new Error('media is required for sendMedia'),
          };
        }

        const defaultExtension = resolveDefaultMediaExtension(msgType);
        const mediaPath = await channel.materializeOutboundMedia(mediaInput, defaultExtension);
        if (!mediaPath) {
          return {
            channel: CHANNEL_ID,
            ok: false,
            messageId: '',
            error: new Error('failed to resolve media input'),
          };
        }

        const chatIdForSend = chatId || undefined;
        if (msgType === 'image') {
          await channel.sendPhoto(chatIdForSend, mediaPath, caption);
        } else if (msgType === 'voice' || msgType === 'audio') {
          await channel.sendDocument(chatIdForSend, mediaPath, caption);
        } else if (msgType === 'video' || msgType === 'file') {
          await channel.sendDocument(chatIdForSend, mediaPath, caption);
        }

        trySetStatusFromParams(params, accountId, {
          lastSendAt: Date.now(),
          lastSendType: 'media',
          lastSendMediaKind: msgType,
          lastSendChatId: chatId,
          lastSendCaptionChars: caption.length,
        });

        return {
          channel: CHANNEL_ID,
          ok: true,
          messageId: randomUUID(),
        };
      } catch (error) {
        const resolvedError = toError(error);
        trySetStatusFromParams(params, accountId, {
          lastSendErrorAt: Date.now(),
          lastSendError: resolvedError.message,
          lastSendErrorCode: extractErrorCode(resolvedError.message) || null,
        });
        return {
          channel: CHANNEL_ID,
          ok: false,
          messageId: '',
          error: resolvedError,
        };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: any): Promise<void> => {
      const accountId = normalizeString(ctx?.accountId || DEFAULT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
      const account = (ctx?.cfg?.channels?.[CHANNEL_ID] ?? {}) as WxFileHelperConfig;

      await stopRunner(accountId);

      const channel = new WxFileHelperChannel(account, ctx.log);
      channelsByAccountId.set(accountId, channel);

      if (!channel.enabled) {
        ctx.log?.info?.('[wx-filehelper] account disabled, skip start');
        ctx.setStatus?.({ accountId, configured: true, running: false, disabled: true });
        return;
      }

      await channel.ensureDirectories();

      const runner: PollRunner = {
        stopRequested: false,
        promise: Promise.resolve(),
      };

      runner.promise = runPollingLoop({
        accountId,
        runner,
        ctx,
        channel,
      })
        .catch((error) => {
          ctx.log?.error?.(`[wx-filehelper] 轮询任务异常退出: ${String(error)}`);
          ctx.setStatus?.({ accountId, running: false, lastError: String(error) });
        })
        .finally(() => {
          if (runnersByAccountId.get(accountId) === runner) {
            runnersByAccountId.delete(accountId);
          }
        });

      runnersByAccountId.set(accountId, runner);

      ctx.setStatus?.({
        accountId,
        configured: true,
        running: true,
        baseUrl: normalizeString(account.baseUrl || 'http://127.0.0.1:8000'),
        lastStartAt: Date.now(),
      });

      ctx.log?.info?.(`[wx-filehelper] poller started for account ${accountId}`);
    },

    stopAccount: async (ctx: any): Promise<void> => {
      const accountId = normalizeString(ctx?.accountId || DEFAULT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
      await stopRunner(accountId);
      channelsByAccountId.delete(accountId);
      ctx.setStatus?.({ accountId, running: false, lastStopAt: Date.now() });
      ctx.log?.info?.(`[wx-filehelper] poller stopped for account ${accountId}`);
    },
  },
};

const plugin = {
  id: CHANNEL_ID,
  name: 'Wx FileHelper',
  description: '微信文件传输助手通信插件，支持文本与媒体收发',
  configSchema: wxFileHelperPlugin.configSchema,

  register(api: any) {
    runtimeFromRegister = api?.runtime ?? null;
    api.registerChannel({ plugin: wxFileHelperPlugin });
  },
};

export { wxFileHelperPlugin };
export default plugin;
