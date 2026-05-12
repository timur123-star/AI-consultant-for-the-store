import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем groq-sdk до импорта src/voice.js.
const createMock = vi.fn();
vi.mock('groq-sdk', () => {
  class GroqMock {
    audio: { transcriptions: { create: typeof createMock } };
    constructor() {
      this.audio = { transcriptions: { create: createMock } };
    }
  }
  return {
    default: GroqMock,
    // toFile нам нужен для buffer → Uploadable. Возвращаем что-то, что
    // create() примет как файл (он мокнут).
    toFile: async (buf: Buffer | Uint8Array, name: string) => ({
      __mocked: true,
      name,
      size: buf.length,
    }),
  };
});

const { transcribeBuffer, transcribeVoiceMessage, MAX_VOICE_SECONDS, MAX_VOICE_BYTES } =
  await import('../src/voice.js');

beforeEach(() => {
  createMock.mockReset();
});

describe('transcribeBuffer', () => {
  it('возвращает text из ответа Groq', async () => {
    createMock.mockResolvedValueOnce({ text: '  Привет, нужна сумка  ' });
    const text = await transcribeBuffer(Buffer.from('fake-ogg-bytes'));
    expect(text).toBe('Привет, нужна сумка');
    expect(createMock).toHaveBeenCalledOnce();
    const arg = createMock.mock.calls[0][0];
    expect(arg.model).toMatch(/whisper/);
    expect(arg.language).toBe('ru');
    expect(arg.response_format).toBe('json');
  });

  it('пустой text → пустая строка', async () => {
    createMock.mockResolvedValueOnce({ text: '' });
    expect(await transcribeBuffer(Buffer.from('a'))).toBe('');
  });

  it('пробрасывает ошибки Groq', async () => {
    createMock.mockRejectedValueOnce(new Error('groq is down'));
    await expect(transcribeBuffer(Buffer.from('a'))).rejects.toThrow('groq is down');
  });
});

describe('transcribeVoiceMessage', () => {
  function makeCtx({ duration = 5, fileId = 'F1', fetchOk = true, fileBytes = 100 } = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: fetchOk,
      status: fetchOk ? 200 : 500,
      statusText: fetchOk ? 'OK' : 'Error',
      headers: { get: () => String(fileBytes) },
      arrayBuffer: async () => new ArrayBuffer(fileBytes),
    });
    globalThis.fetch = fetchMock;
    return {
      telegram: {
        getFileLink: vi.fn().mockResolvedValue({ href: 'https://api.telegram.org/file/voice.ogg' }),
      },
      _voice: { file_id: fileId, duration },
      _fetchMock: fetchMock,
    };
  }

  it('качает файл и возвращает транскрипт', async () => {
    const ctx = makeCtx();
    createMock.mockResolvedValueOnce({ text: 'голосом ищу сумку' });
    const text = await transcribeVoiceMessage(ctx, ctx._voice);
    expect(text).toBe('голосом ищу сумку');
    expect(ctx.telegram.getFileLink).toHaveBeenCalledWith('F1');
    expect(ctx._fetchMock).toHaveBeenCalled();
  });

  it('бросает VOICE_TOO_LONG при превышении MAX_VOICE_SECONDS', async () => {
    const ctx = makeCtx({ duration: MAX_VOICE_SECONDS + 1 });
    await expect(transcribeVoiceMessage(ctx, ctx._voice)).rejects.toMatchObject({
      code: 'VOICE_TOO_LONG',
    });
  });

  it('падает если file_id отсутствует', async () => {
    const ctx = makeCtx();
    await expect(
      transcribeVoiceMessage(ctx, {} as unknown as import('../src/voice.js').TelegramVoice)
    ).rejects.toThrow(/file_id/);
  });

  it('падает если download вернул не-2xx', async () => {
    const ctx = makeCtx({ fetchOk: false });
    await expect(transcribeVoiceMessage(ctx, ctx._voice)).rejects.toThrow(/download voice/);
  });

  it('падает если файл слишком большой', async () => {
    const ctx = makeCtx({ fileBytes: MAX_VOICE_BYTES + 1 });
    await expect(transcribeVoiceMessage(ctx, ctx._voice)).rejects.toThrow(/too large/);
  });
});
