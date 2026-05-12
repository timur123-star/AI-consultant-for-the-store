// Транскрипция голосовых сообщений Telegram через Groq Whisper.
// Telegram voice notes приходят в OGG/Opus, что Whisper понимает нативно.
// Никаких ffmpeg-конвертаций не нужно.
//
// Ограничения:
//  - длительность ≤ MAX_VOICE_SECONDS (60 с по умолчанию). Длинные сообщения
//    стоят CPU и крошат UX — пользователь ждёт минуту минимум.
//  - размер файла ≤ MAX_VOICE_BYTES. Telegram Bot API сам режет загрузку
//    на 20 MB, мы перепроверяем для надёжности.
//
// API ключ — общий `GROQ_API_KEY`. Модель `whisper-large-v3-turbo` —
// ~10× быстрее large-v3 при сравнимом качестве (см. https://console.groq.com/docs/models).
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { config } from './config.js';
import { child } from './log.js';
import { inc, recordLatency } from './metrics.js';

const log = child('voice');

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';

export const MAX_VOICE_SECONDS = Number(process.env.MAX_VOICE_SECONDS || 60);

// 20 MB — лимит Telegram Bot API на download.
export const MAX_VOICE_BYTES = Number(process.env.MAX_VOICE_BYTES || 20 * 1024 * 1024);

let client: Groq | null = null;
function getClient(): Groq {
  if (!client) client = new Groq({ apiKey: config.groqApiKey });
  return client;
}

// Структура voice-сообщения, которую ждём от Telegram (подмножество tg-types).
export interface TelegramVoice {
  file_id: string;
  duration?: number;
}

// Минимальный контракт для telegram-клиента, используемый здесь — getFileLink.
export interface TelegramFileFetcher {
  getFileLink(fileId: string): Promise<URL | string>;
}

export interface VoiceContext {
  telegram: TelegramFileFetcher;
}

export interface VoiceError extends Error {
  code?: string;
}

// Telegram присылает file_id и duration в `ctx.message.voice`. Достаём
// прямую ссылку на ogg-файл (валидна 1 час) и качаем его в память.
async function downloadFile(telegram: TelegramFileFetcher, fileId: string): Promise<Buffer> {
  const link = await telegram.getFileLink(fileId);
  const url = typeof link === 'string' ? link : link.href;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download voice failed: ${res.status} ${res.statusText}`);
  }
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_VOICE_BYTES) {
    throw new Error(`voice file too large: ${contentLength} > ${MAX_VOICE_BYTES}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_VOICE_BYTES) {
    throw new Error(`voice file too large: ${buf.length} > ${MAX_VOICE_BYTES}`);
  }
  return buf;
}

export interface TranscribeBufferOptions {
  filename?: string;
  language?: string;
}

// Публичная функция для тестов: транскрибируем уже скачанный Buffer.
// `language: 'ru'` явно — у нас бот русскоязычный, это даёт стабильность.
export async function transcribeBuffer(
  buf: Buffer | Uint8Array,
  { filename = 'voice.ogg', language = 'ru' }: TranscribeBufferOptions = {}
): Promise<string> {
  const file = await toFile(buf, filename);
  const started = Date.now();
  const result = (await getClient().audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    language,
    response_format: 'json',
  })) as { text?: string };
  recordLatency('whisper_ms', Date.now() - started);
  const text = (result?.text || '').trim();
  inc('voice_transcribed_total');
  return text;
}

// Полный путь от Telegram voice-сообщения до текста.
export async function transcribeVoiceMessage(
  ctx: VoiceContext,
  voice: TelegramVoice
): Promise<string> {
  if (!voice?.file_id) throw new Error('voice.file_id missing');
  if (voice.duration && voice.duration > MAX_VOICE_SECONDS) {
    const err: VoiceError = new Error(`voice too long: ${voice.duration}s > ${MAX_VOICE_SECONDS}s`);
    err.code = 'VOICE_TOO_LONG';
    throw err;
  }
  const buf = await downloadFile(ctx.telegram, voice.file_id);
  log.info(
    { duration: voice.duration, bytes: buf.length, model: WHISPER_MODEL },
    'транскрибирую голосовое'
  );
  return transcribeBuffer(buf, { filename: 'voice.ogg', language: 'ru' });
}
