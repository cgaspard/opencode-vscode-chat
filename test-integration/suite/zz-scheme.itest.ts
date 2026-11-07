// End-to-end test of the wrong-scheme banner (v0.19): a local endpoint saved
// as https:// for a FAKE plain-http LM Studio, the way "https://192.168.x.x:1234"
// fails against a real one. Exercises the real bridge → LocalClient → fetch
// path: the TLS handshake fails, the http probe answers, the banner names the
// problem, and "Use http" edits the provider and connects (starting the
// embedded OpenCode engine for real).
//
// Named zz-* so it runs after the injection-driven suites: it drives a real
// connection whose health loop keeps running afterwards.
import * as assert from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { openPanel, count, click, text, waitFor } = helpers;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal plain-http LM Studio stand-in with a request log. */
class FakeLmStudio {
  private server: http.Server | undefined;
  private sockets = new Set<Socket>();
  port = 0;
  paths: string[] = [];

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      this.paths.push(path);
      const json = (body: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      switch (path) {
        case '/lmstudio-greeting':
          return json({ lmstudio: true });
        case '/api/v1/models':
          return json({
            models: [
              {
                key: 'e2e/fake-model',
                type: 'llm',
                max_context_length: 8192,
                capabilities: { trained_for_tool_use: true },
                loaded_instances: [{ config: { context_length: 4096 } }],
              },
            ],
          });
        case '/api/v0/models':
          return json({ data: [] });
        case '/v1/models':
          return json({ data: [{ id: 'e2e/fake-model' }] });
        default:
          res.statusCode = 404;
          return void res.end('{}');
      }
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) {
      s.destroy();
    }
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

describe('wrong-scheme banner e2e', function () {
  this.timeout(120_000);
  const fake = new FakeLmStudio();
  let restore: { id: string } | undefined;

  before(async function () {
    this.timeout(90_000);
    // Earlier suites leave panels (and their health loops) alive; start clean.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);
    await fake.start();
    restore = await vscode.commands.executeCommand('opencodeChat._test.useServer', `https://127.0.0.1:${fake.port}/v1`);
    await openPanel({ quiesce: false }); // useServer already made the fake the only provider
  });

  after(async () => {
    if (restore) {
      await vscode.commands.executeCommand('opencodeChat._test.restoreServer', restore);
    }
    await fake.stop();
  });

  it('names the scheme problem instead of "isn\'t responding"', async () => {
    await waitFor('#conn-fix-scheme', (n) => n === 1, 20_000);
    assert.match((await text('#conn-banner .conn-title'))!, /E2E Fake answers over http, not https/);
    const sub = (await text('#conn-banner .conn-sub'))!;
    assert.ok(sub.includes(`https://127.0.0.1:${fake.port}/v1`), `sub should show the failing URL: ${sub}`);
    assert.ok(sub.includes(`http://127.0.0.1:${fake.port}/v1`), `sub should show the working URL: ${sub}`);
    assert.strictEqual(await text('#conn-fix-scheme'), 'Use http');
  });

  it('"Use http" edits the provider and connects', async () => {
    const before = fake.paths.length;
    assert.ok(await click('#conn-fix-scheme'), 'fix button should be clickable');
    await waitFor('#conn-banner:not(.hidden)', (n) => n === 0, 60_000);
    assert.strictEqual(await count('#conn-fix-scheme'), 0, 'banner and fix button are gone');
    assert.ok(
      fake.paths.slice(before).some((p) => p === '/v1/models' || p === '/lmstudio-greeting'),
      'the extension reached the fake over http',
    );
  });
});
