import { describe, it, expect } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { handleDocsRequest, verifyDocsAvailable } from '../src/docs.js';

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function get(server: http.Server, path: string): Promise<Resp> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      })
      .on('error', reject);
  });
}

function startTestServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await handleDocsRequest(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('not docs');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('verifyDocsAvailable', () => {
  it('видит и spec, и swagger-ui-dist', async () => {
    const { spec, ui } = await verifyDocsAvailable();
    expect(spec).toBe(true);
    expect(ui).toBe(true);
  });
});

describe('handleDocsRequest', () => {
  it('GET /docs возвращает HTML с Swagger UI', async () => {
    const server = await startTestServer();
    try {
      const resp = await get(server, '/docs');
      expect(resp.status).toBe(200);
      expect(String(resp.headers['content-type'])).toContain('text/html');
      expect(resp.body).toContain('swagger-ui');
      expect(resp.body).toContain('/docs/openapi.yaml');
    } finally {
      server.close();
    }
  });

  it('GET /docs/openapi.yaml отдаёт YAML спеку', async () => {
    const server = await startTestServer();
    try {
      const resp = await get(server, '/docs/openapi.yaml');
      expect(resp.status).toBe(200);
      expect(String(resp.headers['content-type'])).toContain('application/yaml');
      expect(resp.body).toContain('openapi:');
      expect(resp.body).toContain('/health');
      expect(resp.body).toContain('/metrics');
    } finally {
      server.close();
    }
  });

  it('GET /docs/swagger-ui.css отдаёт CSS', async () => {
    const server = await startTestServer();
    try {
      const resp = await get(server, '/docs/swagger-ui.css');
      expect(resp.status).toBe(200);
      expect(String(resp.headers['content-type'])).toContain('text/css');
      expect(resp.body.length).toBeGreaterThan(100);
    } finally {
      server.close();
    }
  });

  it('блокирует path-traversal через whitelist ассетов', async () => {
    const server = await startTestServer();
    try {
      const resp = await get(server, '/docs/../package.json');
      // path-traversal либо 404 от docs, либо нормализуется и не наш урл
      expect([404, 200]).toContain(resp.status);
      expect(resp.body).not.toContain('"name": "ai-consultant-for-the-store"');
    } finally {
      server.close();
    }
  });

  it('возвращает false для не-docs урлов', async () => {
    const server = await startTestServer();
    try {
      const resp = await get(server, '/something-else');
      expect(resp.status).toBe(404);
      expect(resp.body).toBe('not docs');
    } finally {
      server.close();
    }
  });
});
