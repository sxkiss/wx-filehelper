import axios, { type AxiosInstance } from 'axios';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

/**
 * @input axios/form-data 与 node:fs/node:path，用于调用 wx-filehelper-api、处理二维码与媒体缓存文件
 * @output WxFileHelperChannel，提供登录态检测、消息轮询解析、文本/媒体发送能力
 * @position wx-filehelper 通信协议层，承接 API 交互与消息标准化
 * @auto-doc Update header and folder INDEX.md when this file changes
 */

export interface WxFileHelperConfig {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  requestTimeout?: number;
  pollingTimeout?: number;
  pollingLimit?: number;
  pollingInterval?: number;
  loginAutoPoll?: boolean;
  loginCheckInterval?: number;
  qrRefreshInterval?: number;
  skipHistoryOnStart?: boolean;
  startupSyncLimit?: number;
  qrSavePath?: string;
  mediaCacheDir?: string;
  defaultChatId?: string;
}

export type WxFileHelperInboundType = 'text' | 'image' | 'file' | 'voice' | 'video' | 'unknown';

export type WxFileHelperInboundMessage = {
  updateId: number;
  messageId: string;
  chatType: 'direct' | 'group';
  chatId: string;
  senderId: string;
  type: WxFileHelperInboundType;
  text: string;
  mediaCandidates: string[];
  rawUpdate: Record<string, unknown>;
};

export type OutboundMediaInput =
  | string
  | {
      kind: 'path' | 'url' | 'base64';
      value: string;
      filename?: string;
    };

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type WxApiUpdate = {
  update_id?: number;
  message?: Record<string, unknown>;
};

type PollingBatch = {
  updates: WxApiUpdate[];
  nextOffset: number;
};

type LoginStatus = {
  online: boolean;
  detail: Record<string, unknown>;
};

function toSafeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return null;
    }
    const parsed = Number.parseInt(text, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const resolved = toSafeInteger(value);
  if (resolved === null) {
    return fallback;
  }
  return Math.max(min, Math.min(max, resolved));
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return null;
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function isImageExtension(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(extension);
}

function sanitizeFilename(raw: string, fallback: string): string {
  const name = raw.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!name) {
    return fallback;
  }
  return name;
}

export class WxFileHelperChannel {
  private readonly config: Required<Omit<WxFileHelperConfig, 'name' | 'enabled'>> & {
    enabled: boolean;
    name?: string;
  };

  private readonly client: AxiosInstance;
  private readonly logger: LoggerLike;
  private lastQrFetchedAt = 0;

  constructor(config: WxFileHelperConfig, logger?: LoggerLike) {
    const baseUrl = normalizeString(config.baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    const cwd = process.cwd();
    const configuredMediaCacheDir = normalizeString(config.mediaCacheDir || 'media/wx-filehelper');
    const configuredQrSavePath = normalizeString(config.qrSavePath || '');
    const mediaCacheDir = isAbsolute(configuredMediaCacheDir)
      ? configuredMediaCacheDir
      : resolve(cwd, configuredMediaCacheDir);
    const qrSavePath = configuredQrSavePath
      ? (isAbsolute(configuredQrSavePath) ? configuredQrSavePath : resolve(cwd, configuredQrSavePath))
      : '';

    this.config = {
      enabled: config.enabled !== false,
      name: normalizeString(config.name || ''),
      baseUrl,
      requestTimeout: clampInteger(config.requestTimeout, 10_000, 1_000, 120_000),
      pollingTimeout: clampInteger(config.pollingTimeout, 20, 1, 60),
      pollingLimit: clampInteger(config.pollingLimit, 50, 1, 100),
      pollingInterval: clampInteger(config.pollingInterval, 1_000, 200, 30_000),
      loginAutoPoll: config.loginAutoPoll === true,
      loginCheckInterval: clampInteger(config.loginCheckInterval, 3_000, 500, 30_000),
      qrRefreshInterval: clampInteger(config.qrRefreshInterval, 30_000, 3_000, 300_000),
      skipHistoryOnStart: config.skipHistoryOnStart !== false,
      startupSyncLimit: clampInteger(config.startupSyncLimit, 100, 1, 100),
      qrSavePath,
      mediaCacheDir,
      defaultChatId: normalizeString(config.defaultChatId || ''),
    };

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.requestTimeout,
      validateStatus: () => true,
    });

    this.logger = logger ?? {};
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get defaultChatId(): string {
    return this.config.defaultChatId;
  }

  get pollingInterval(): number {
    return this.config.pollingInterval;
  }

  get loginCheckInterval(): number {
    return this.config.loginCheckInterval;
  }

  get skipHistoryOnStart(): boolean {
    return this.config.skipHistoryOnStart;
  }

  get startupSyncLimit(): number {
    return this.config.startupSyncLimit;
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.config.mediaCacheDir, { recursive: true });

    if (this.config.qrSavePath) {
      await mkdir(dirname(this.config.qrSavePath), { recursive: true });
    }
  }

  async checkLoginStatus(): Promise<LoginStatus> {
    const response = await this.client.get('/login/status', {
      params: {
        auto_poll: this.config.loginAutoPoll ? 'true' : 'false',
      },
      responseType: 'json',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`/login/status http ${response.status}`);
    }

    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('/login/status 返回非对象');
    }

    const payload = data as Record<string, unknown>;
    const statusText = normalizeString(payload.status).toLowerCase();
    const online =
      payload.logged_in === true ||
      payload.online === true ||
      payload.is_online === true ||
      ['online', 'logged_in', 'loggedin', 'login_success', 'success'].includes(statusText);

    if (!online && payload.qr_code_url && this.config.qrSavePath) {
      const now = Date.now();
      if (now - this.lastQrFetchedAt > this.config.qrRefreshInterval) {
        this.lastQrFetchedAt = now;
        const url = normalizeString(payload.qr_code_url);
        if (url) {
          try {
            await this.downloadMediaToFile(url, '.png', basename(this.config.qrSavePath));
          } catch (error) {
            this.logger.warn?.(`[wx-filehelper] 二维码下载失败: ${String(error)}`);
          }
        }
      }
    }

    return {
      online,
      detail: payload,
    };
  }

  async pollUpdates(offset: number): Promise<PollingBatch> {
    const response = await this.client.get('/bot/getUpdates', {
      params: {
        offset,
        limit: this.config.pollingLimit,
        timeout: this.config.pollingTimeout,
      },
      responseType: 'json',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`/bot/getUpdates http ${response.status}`);
    }

    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('/bot/getUpdates 返回非对象');
    }

    const payload = data as Record<string, unknown>;
    if (payload.ok === false) {
      const errorCode = toSafeInteger(payload.error_code) ?? 0;
      const description = normalizeString(payload.description || payload.error || 'unknown error');
      throw new Error(`/bot/getUpdates failed: ${errorCode} ${description}`.trim());
    }

    const results = payload.result;
    if (!Array.isArray(results)) {
      return { updates: [], nextOffset: offset };
    }

    let nextOffset = offset;
    const updates: WxApiUpdate[] = [];

    for (const item of results) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const update = item as WxApiUpdate;
      const updateId = toSafeInteger(update.update_id);

      if (updateId !== null) {
        nextOffset = Math.max(nextOffset, updateId);
      }
      updates.push(update);
    }

    return { updates, nextOffset };
  }

  async normalizeUpdate(update: WxApiUpdate): Promise<WxFileHelperInboundMessage | null> {
    const message = update.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return null;
    }

    const messageId = normalizeString(message.message_id);
    if (messageId.startsWith('sent_')) {
      return null;
    }

    const sender = this.resolveSenderId(message);
    const chat = this.resolveChatInfo(message, sender);
    const type = this.resolveInboundType(message);
    const text = this.resolveInboundText(message, type);
    const mediaCandidates = await this.resolveInboundMediaCandidates(message, type);

    return {
      updateId: toSafeInteger(update.update_id) ?? 0,
      messageId: this.buildInboundMessageId(messageId, update.update_id),
      chatType: chat.chatType,
      chatId: chat.chatId,
      senderId: sender,
      type,
      text,
      mediaCandidates,
      rawUpdate: {
        update_id: update.update_id,
        message,
      },
    };
  }

  private buildInboundMessageId(messageId: string, updateId: unknown): string {
    if (messageId) {
      return messageId;
    }
    const safeUpdateId = toSafeInteger(updateId);
    if (safeUpdateId !== null) {
      return `update-${safeUpdateId}`;
    }
    return `synthetic-${Date.now()}-${randomUUID()}`;
  }

  private resolveSenderId(message: Record<string, unknown>): string {
    const from = message.from;
    if (from && typeof from === 'object' && !Array.isArray(from)) {
      const record = from as Record<string, unknown>;
      const id = normalizeString(record.id || record.username);
      if (id) {
        return id;
      }
    }

    const sender = normalizeString(message.sender || message.from_user || message.author);
    if (sender) {
      return sender;
    }

    return 'unknown';
  }

  private resolveChatInfo(
    message: Record<string, unknown>,
    fallbackSenderId: string,
  ): { chatType: 'direct' | 'group'; chatId: string } {
    const chat = message.chat;
    if (chat && typeof chat === 'object' && !Array.isArray(chat)) {
      const chatRecord = chat as Record<string, unknown>;
      const chatId = normalizeString(chatRecord.id);
      const chatTypeRaw = normalizeString(chatRecord.type).toLowerCase();
      const chatType = ['group', 'supergroup', 'channel'].includes(chatTypeRaw) ? 'group' : 'direct';

      if (chatId) {
        return {
          chatType,
          chatId: chatType === 'group' ? `${chatId}@chatroom` : chatId,
        };
      }
    }

    const chatId = normalizeString(message.chat_id || this.config.defaultChatId || fallbackSenderId);
    return {
      chatType: chatId.endsWith('@chatroom') ? 'group' : 'direct',
      chatId,
    };
  }

  private resolveInboundType(message: Record<string, unknown>): WxFileHelperInboundType {
    const type = normalizeString(message.type).toLowerCase();
    if (!type || type === 'text') {
      return 'text';
    }

    if (['photo', 'image', 'picture'].includes(type) || message.photo || message.image) {
      return 'image';
    }

    if (['file', 'document'].includes(type) || message.document) {
      return 'file';
    }

    if (['voice', 'audio'].includes(type)) {
      return 'voice';
    }

    if (type === 'video') {
      return 'video';
    }

    return 'unknown';
  }

  private resolveInboundText(message: Record<string, unknown>, type: WxFileHelperInboundType): string {
    const text = normalizeString(message.text || message.caption || message.content);
    if (text) {
      return text;
    }

    if (type === 'image') {
      return '[图片消息]';
    }
    if (type === 'file') {
      return '[文件消息]';
    }
    if (type === 'voice') {
      return '[语音消息]';
    }
    if (type === 'video') {
      return '[视频消息]';
    }

    return '';
  }

  private async resolveInboundMediaCandidates(
    message: Record<string, unknown>,
    type: WxFileHelperInboundType,
  ): Promise<string[]> {
    const directCandidates: string[] = [];
    const quotedCandidates: string[] = [];

    const append = (target: string[], value: unknown): void => {
      const text = this.normalizeInboundMediaCandidate(normalizeString(value));
      if (!text) {
        return;
      }

      if (!target.includes(text)) {
        target.push(text);
      }
    };

    const extractFromObject = (target: string[], obj: unknown, keys: string[]): void => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return;
      }
      const record = obj as Record<string, unknown>;
      for (const key of keys) {
        append(target, record[key]);
      }
    };

    extractFromObject(directCandidates, message.image, ['url', 'file_path', 'path']);
    extractFromObject(directCandidates, message.document, ['url', 'file_path', 'path']);
    extractFromObject(directCandidates, message.voice, ['url', 'file_path', 'path']);
    extractFromObject(directCandidates, message.video, ['url', 'file_path', 'path']);

    const photo = message.photo;
    if (Array.isArray(photo)) {
      const latest = photo[photo.length - 1];
      extractFromObject(directCandidates, latest, ['url', 'file_path', 'path']);

      if (latest && typeof latest === 'object' && !Array.isArray(latest)) {
        const record = latest as Record<string, unknown>;
        const fileId = normalizeString(record.file_id);
        if (fileId) {
          const resolved = await this.resolveFilePathById(fileId);
          append(directCandidates, resolved);
        }
      }
    }

    const messageFileId = this.resolveMessageFileId(message);
    if (messageFileId) {
      const resolved = await this.resolveFilePathById(messageFileId);
      append(directCandidates, resolved);
    }

    const quote = message.quote || message.reply_to || message.reply_to_message || message.quoted_message;
    if (quote && typeof quote === 'object') {
      extractFromObject(quotedCandidates, quote, ['url', 'file_path', 'path']);

      const quotedMsg = quote as Record<string, unknown>;
      extractFromObject(quotedCandidates, quotedMsg.image, ['url', 'file_path', 'path']);
      extractFromObject(quotedCandidates, quotedMsg.document, ['url', 'file_path', 'path']);
      extractFromObject(quotedCandidates, quotedMsg.voice, ['url', 'file_path', 'path']);
      extractFromObject(quotedCandidates, quotedMsg.video, ['url', 'file_path', 'path']);

      if (Array.isArray(quotedMsg.photo)) {
        const latest = quotedMsg.photo[quotedMsg.photo.length - 1];
        extractFromObject(quotedCandidates, latest, ['url', 'file_path', 'path']);
        if (latest && typeof latest === 'object' && !Array.isArray(latest)) {
          const record = latest as Record<string, unknown>;
          const fileId = normalizeString(record.file_id);
          if (fileId) {
            try {
              const resolved = await this.resolveFilePathById(fileId);
              append(quotedCandidates, resolved);
            } catch {
              // ignore
            }
          }
        }
      }
    }

    if (directCandidates.length > 0) {
      return directCandidates;
    }

    if (type === 'text' || type === 'unknown' || quotedCandidates.length > 0) {
      return quotedCandidates;
    }

    return [];
  }

  private normalizeInboundMediaCandidate(raw: string): string {
    const value = normalizeString(raw);
    if (!value) {
      return '';
    }

    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) {
      return value;
    }

    const normalized = value.replace(/\\/g, '/');

    if (normalized.startsWith('/data/downloads/')) {
      return this.toStaticDownloadUrl(normalized.slice('/data/downloads/'.length));
    }

    if (normalized.startsWith('/downloads/')) {
      return this.toStaticDownloadUrl(normalized.slice('/downloads/'.length));
    }

    if (normalized.startsWith('downloads/')) {
      return this.toStaticDownloadUrl(normalized.slice('downloads/'.length));
    }

    if (normalized.startsWith('/static/')) {
      return `${this.config.baseUrl}${normalized}`;
    }

    if (normalized.startsWith('static/')) {
      return `${this.config.baseUrl}/${normalized}`;
    }

    return value;
  }

  private toStaticDownloadUrl(relativePath: string): string {
    const path = relativePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return `${this.config.baseUrl}/static/${path}`;
  }

  private resolveMessageFileId(message: Record<string, unknown>): string | null {
    const fileId = normalizeString(message.file_id);
    if (fileId) {
      return fileId;
    }
    return null;
  }

  private async resolveFilePathById(fileId: string): Promise<string> {
    // If fileId looks like a path or URL, return it directly
    if (fileId.startsWith('http') || fileId.includes('/') || fileId.includes('\\')) {
      return this.normalizeInboundMediaCandidate(fileId);
    }

    try {
      const response = await this.client.get('/bot/getFile', {
        params: { file_id: fileId },
        responseType: 'json',
      });

      if (response.status === 200 && response.data && response.data.ok) {
        const filePath = normalizeString(response.data.result?.file_path);
        if (filePath) {
          return this.normalizeInboundMediaCandidate(filePath);
        }
      }
    } catch (e) {
      // ignore
    }
    
    // Fallback: return fileId as is, hoping downstream can handle it or it's just an ID
    return fileId;
  }

  async sendText(chatId: string | undefined, text: string): Promise<void> {
    const body: Record<string, unknown> = {
      text,
    };

    if (chatId) {
      body.chat_id = chatId;
    }

    await this.postJson('/bot/sendMessage', body);
  }

  async sendPhoto(chatId: string | undefined, photoPath: string, caption?: string): Promise<void> {
    await this.uploadMedia('/bot/sendPhoto/upload', 'photo', photoPath, chatId, caption);
  }

  async sendDocument(chatId: string | undefined, documentPath: string, caption?: string): Promise<void> {
    await this.uploadMedia('/bot/sendDocument/upload', 'document', documentPath, chatId, caption);
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<void> {
    // wx-filehelper-api 有时会返回空 body 或非 JSON（例如仅返回 "ok"），
    // axios 在 responseType='json' 下会直接抛 "Unexpected end of JSON input"。
    // 这里统一用 text 接收，然后尽力解析。
    const response = await this.client.post(path, body, {
      responseType: 'text',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${path} http ${response.status}`);
    }

    const payload = parseMaybeJsonObject(response.data);
    if (payload && payload.ok === false) {
      const errorCode = toSafeInteger(payload.error_code) ?? 0;
      const description = normalizeString(payload.description || payload.error || 'unknown error');
      throw new Error(`${path} failed: ${errorCode} ${description}`.trim());
    }
  }

  private async uploadMedia(
    path: string,
    fieldName: 'photo' | 'document',
    mediaPath: string,
    chatId?: string,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.append(fieldName, createReadStream(mediaPath), basename(mediaPath));
    if (chatId) {
      form.append('chat_id', chatId);
    }
    if (caption) {
      form.append('caption', caption);
    }

    const response = await this.client.post(path, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: 'text',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${path} http ${response.status}`);
    }

    const payload = parseMaybeJsonObject(response.data);
    if (payload && payload.ok === false) {
      const errorCode = toSafeInteger(payload.error_code) ?? 0;
      const description = normalizeString(payload.description || payload.error || 'unknown error');
      throw new Error(`${path} failed: ${errorCode} ${description}`.trim());
    }
  }

  async materializeOutboundMedia(input: OutboundMediaInput, defaultExtension: string): Promise<string | null> {
    if (typeof input === 'string') {
      const normalized = normalizeString(input);
      if (!normalized) {
        return null;
      }

      if (existsSync(normalized)) {
        return normalized;
      }

      if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
        return this.downloadMediaToFile(normalized, defaultExtension);
      }

      if (normalized.startsWith('data:')) {
        const [meta, encoded] = normalized.split(',', 2);
        const extension = meta.includes('image/') ? '.jpg' : defaultExtension;
        return this.decodeBase64ToFile(encoded || '', extension, undefined);
      }

      return null;
    }

    const kind = input.kind;
    if (kind === 'path') {
      const mediaPath = normalizeString(input.value);
      if (!mediaPath || !existsSync(mediaPath)) {
        return null;
      }
      return mediaPath;
    }

    if (kind === 'url') {
      return this.downloadMediaToFile(normalizeString(input.value), defaultExtension, input.filename);
    }

    if (kind === 'base64') {
      return this.decodeBase64ToFile(normalizeString(input.value), defaultExtension, input.filename);
    }

    return null;
  }

  async downloadMediaToFile(url: string, defaultExtension: string, filename?: string): Promise<string | null> {
    const mediaUrl = normalizeString(url);
    if (!mediaUrl) {
      return null;
    }

    try {
      const response = await this.client.get(mediaUrl, {
        baseURL: undefined,
        responseType: 'arraybuffer',
        timeout: this.config.requestTimeout,
      });

      if (response.status < 200 || response.status >= 300) {
        return null;
      }

      const extension = extname(new URL(mediaUrl).pathname) || defaultExtension;
      const safeName = sanitizeFilename(filename || `wx-filehelper-${Date.now()}-${randomUUID()}${extension}`, `wx-filehelper-${Date.now()}${defaultExtension}`);
      const target = join(this.config.mediaCacheDir, safeName);

      await writeFile(target, Buffer.from(response.data));
      return target;
    } catch (error) {
      this.logger.warn?.(`[wx-filehelper] 下载媒体失败: ${String(error)}`);
      return null;
    }
  }

  async decodeBase64ToFile(base64Value: string, defaultExtension: string, filename?: string): Promise<string | null> {
    const raw = normalizeString(base64Value);
    if (!raw) {
      return null;
    }

    const normalized = raw.startsWith('data:') && raw.includes(',') ? raw.split(',', 2)[1] : raw;

    try {
      const buffer = Buffer.from(normalized, 'base64');
      if (!buffer.length) {
        return null;
      }

      const baseName = sanitizeFilename(filename || `wx-filehelper-${Date.now()}-${randomUUID()}`, 'wx-filehelper-media');
      const extension = extname(baseName) || defaultExtension;
      const finalName = extname(baseName) ? baseName : `${baseName}${extension}`;
      const target = join(this.config.mediaCacheDir, finalName);
      await writeFile(target, buffer);
      return target;
    } catch (error) {
      this.logger.warn?.(`[wx-filehelper] Base64 媒体解码失败: ${String(error)}`);
      return null;
    }
  }

  resolveMediaMethod(filePath: string): 'photo' | 'document' {
    if (isImageExtension(filePath)) {
      return 'photo';
    }
    return 'document';
  }

  async ensureOnline(): Promise<boolean> {
    try {
      const status = await this.checkLoginStatus();
      return status.online;
    } catch {
      return false;
    }
  }

  async fetchUpdates(offset: number): Promise<PollingBatch> {
    return this.pollUpdates(offset);
  }


  async syncStartupOffset(startOffset: number): Promise<{ offset: number; skipped: number }> {
    if (!this.config.skipHistoryOnStart) {
      return { offset: Math.max(0, startOffset), skipped: 0 };
    }

    let offset = Math.max(0, startOffset);
    let skipped = 0;

    try {
      while (true) {
        const response = await this.client.get('/bot/getUpdates', {
          params: {
            offset,
            limit: this.config.startupSyncLimit,
            timeout: 0,
          },
          responseType: 'json',
        });

        if (response.status < 200 || response.status >= 300) {
          break;
        }

        const payload = response.data as Record<string, unknown>;
        if (!payload || payload.ok === false || !Array.isArray(payload.result) || payload.result.length === 0) {
          break;
        }

        const results = payload.result as Array<Record<string, unknown>>;
        skipped += results.length;

        const last = results[results.length - 1];
        const lastId = toSafeInteger(last?.update_id);
        if (lastId === null || lastId <= offset) {
          break;
        }

        offset = lastId;

        if (results.length < this.config.startupSyncLimit) {
          break;
        }
      }

      return { offset, skipped };
    } catch {
      return { offset, skipped };
    }
  }
}
