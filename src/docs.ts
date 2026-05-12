// Подача Swagger UI поверх docs/openapi.yaml.
//
// Используем `swagger-ui-dist` — pre-built статические ассеты Swagger UI.
// Это даёт zero-runtime-dependency: мы не таскаем Express и middleware,
// а отдаём готовые html/js/css из node_modules + одну дешёвую YAML-страницу.
//
// Эндпоинты:
//   GET /docs                            → HTML с шапкой и инициализированным SwaggerUIBundle
//   GET /docs/openapi.yaml               → сама спецификация
//   GET /docs/swagger-ui.css             → ассеты swagger-ui-dist
//   GET /docs/swagger-ui-bundle.js
//   GET /docs/swagger-ui-standalone-preset.js
//   GET /docs/favicon-32x32.png          (опционально)
//
// Сервер пишет на чистом node:http — без Express, чтобы не тянуть лишний deps.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { child } from './log.js';
import { resolveRepoFile } from './paths.js';

const log = child('docs');

// Корень swagger-ui-dist меняется между версиями, поэтому резолвим динамически
// через createRequire — он умеет искать пакет в node_modules.
const require = createRequire(import.meta.url);

function safeSwaggerUiRoot(): string | null {
  try {
    const pkgJson = require.resolve('swagger-ui-dist/package.json');
    return path.dirname(pkgJson);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'swagger-ui-dist не найден');
    return null;
  }
}

const SWAGGER_UI_ROOT = safeSwaggerUiRoot();

// Список ассетов, которые отдаём из swagger-ui-dist. Whitelist предотвращает
// path-traversal через `..`.
const SWAGGER_ASSETS: Record<string, string> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'application/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'application/javascript; charset=utf-8',
  'favicon-32x32.png': 'image/png',
  'favicon-16x16.png': 'image/png',
};

function docsHtml(): string {
  // Минимальная HTML-обёртка — Swagger UI делает всю работу клиент-сайдом.
  // Стили — встроенные, чтобы страница работала без сети (CSP-friendly).
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>AI-consultant for the store — API docs</title>
  <link rel="icon" type="image/png" href="/docs/favicon-32x32.png" sizes="32x32">
  <link rel="stylesheet" href="/docs/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
    .info hgroup.main { padding-top: 16px; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js" crossorigin></script>
  <script src="/docs/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.addEventListener('load', function () {
      window.ui = SwaggerUIBundle({
        url: '/docs/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        defaultModelsExpandDepth: 1,
        docExpansion: 'list',
      });
    });
  </script>
</body>
</html>`;
}

async function readOpenApiSpec(): Promise<string> {
  const specPath = resolveRepoFile(import.meta.url, 'docs/openapi.yaml');
  return await readFile(specPath, 'utf8');
}

async function tryReadAsset(name: string): Promise<Buffer | null> {
  if (!SWAGGER_UI_ROOT) return null;
  const allowed = Object.prototype.hasOwnProperty.call(SWAGGER_ASSETS, name);
  if (!allowed) return null;
  const filePath = path.join(SWAGGER_UI_ROOT, name);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    return await readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Пробует обработать запрос к /docs* эндпоинтам. Возвращает true, если ответил.
 * Если URL не наш — возвращает false, чтобы bootstrap.ts продолжил роутинг.
 */
export async function handleDocsRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = (req.url || '/').split('?')[0];

  if (url === '/docs' || url === '/docs/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(docsHtml());
    return true;
  }

  if (url === '/docs/openapi.yaml' || url === '/openapi.yaml') {
    try {
      const yaml = await readOpenApiSpec();
      res.writeHead(200, {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(yaml);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'не смог прочитать openapi.yaml');
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('failed to load openapi spec');
    }
    return true;
  }

  if (url.startsWith('/docs/')) {
    const name = url.slice('/docs/'.length);
    const contentType = SWAGGER_ASSETS[name];
    if (!contentType) return false;
    const buf = await tryReadAsset(name);
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buf);
    return true;
  }

  return false;
}

/**
 * Проверяет что и спека и swagger-ui-dist на месте. Вызывается из bootstrap
 * один раз при старте — не падаем, только логируем warn если что-то не так.
 */
export async function verifyDocsAvailable(): Promise<{ spec: boolean; ui: boolean }> {
  let spec: boolean;
  try {
    await readOpenApiSpec();
    spec = true;
  } catch {
    spec = false;
  }
  return { spec, ui: SWAGGER_UI_ROOT !== null };
}
