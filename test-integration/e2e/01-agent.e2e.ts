// The agent: real tools with cards, edits with diffs, todos, plan mode,
// streaming markdown, reasoning blocks, the context meter and tok/s.
import * as assert from 'node:assert';
import * as path from 'node:path';
import { FakeThinker, THINKER_MODEL } from './fakeThinker';
import { ask, BASE_URL, busy, freshChat, h, read, send, until, useServer } from './lib';

describe('e2e · the agent', function () {
  it('reloads a model loaded with too small a window before prompting (LM Studio)', async () => {
    await freshChat();
    // The panel checks the loaded window before every LM Studio prompt and
    // reloads at minContextLength if it is too small for the agent's prompt.
    assert.match(await ask('Reply with exactly: CONTEXT-OK'), /CONTEXT-OK/);
    assert.match(String(await h.text('#model-btn .model-btn-label')), /3\dK|6\dK|12\dK|25\dK/, 'the chip shows a window of at least 32K');
  });

  it('reads a file with a tool and answers from it', async () => {
    await freshChat();
    const reply = await ask('Use the read tool on src/app.txt and tell me the codeword it contains.');
    assert.match(reply, /BANANA-17/);
    const tools = await h.allText('.msg.assistant .part-tool');
    assert.ok(tools.some((t) => /app\.txt/.test(t)), `a tool card names the file (cards: ${tools.join(' | ')})`);
    assert.ok((await h.count('.part-tool .tool-line.status-completed')) > 0, 'the tool card rendered as completed');
  });

  it('edits a file and shows the diff on its card', async () => {
    await freshChat();
    await ask('Use the edit tool to change "version = v1" to "version = v2" in src/app.txt. Change nothing else.');
    assert.match(read('src', 'app.txt'), /version = v2/);
    assert.match(read('src', 'app.txt'), /codeword = BANANA-17/, 'the rest of the file is intact');
    // Expand the edit card: its diff comes from the tool's patch metadata.
    const names = await h.allText('.msg.assistant .part-tool .tool-name');
    const edit = names.lastIndexOf('edit');
    assert.ok(edit >= 0, `an edit card (cards: ${names.join(', ')})`);
    await h.click('.msg.assistant .part-tool .tool-line', edit);
    await until(async () => (await h.count('.tool-diff')) > 0, 5000, 'the diff to render');
    assert.match(String(await h.text('.tool-diff')), /v2/);
  });

  it('keeps a live todo list', async () => {
    await freshChat();
    await ask(
      'Use the todo tool to write a plan with exactly three items: "alpha", "beta", "gamma". Then mark "alpha" completed with the todo tool. Then reply with the word PLANNED.',
    );
    await until(async () => (await h.count('.todo-card')) > 0, 10_000, 'the todo card');
    const items = (await h.allText('.todo-card .todo-text')).join(' ');
    assert.match(items, /alpha/);
    assert.match(items, /gamma/);
    const progress = String(await h.text('.todo-card .todo-count'));
    assert.match(progress, /1\s*\/\s*3/, `progress counts the completed item (${progress}; items: ${items})`);
  });

  it('plan mode stays read-only', async () => {
    await freshChat({ agent: 'plan' });
    // v2's plan agent may write plan notes to ~/.opencode/plan, which is outside
    // the workspace and so asks first: deny those (a test must not write into
    // the real home directory) and let the turn finish.
    await send('Create a file named plan-should-not-write.txt containing hello.');
    await until(busy, 30_000, 'the turn to start').catch(() => undefined);
    const asked: string[] = [];
    await until(
      async () => {
        if ((await h.count('.perm-card:not(.resolved)')) > 0) {
          asked.push(String(await h.text('.perm-card:not(.resolved) .perm-detail')));
          await h.click('.perm-card:not(.resolved) .perm-btn.reject');
        }
        return !(await busy());
      },
      240_000,
      'the turn to end',
    );
    const fs = await import('node:fs');
    const { ws } = await import('./lib');
    assert.ok(!fs.existsSync(ws('plan-should-not-write.txt')), 'the plan agent must not write files');
    assert.ok(
      asked.every((d) => d.includes(path.join('.opencode', 'plan'))),
      `the only writes it may ask for are plan notes (asked: ${asked.join(' | ')})`,
    );
  });

  it('streams markdown with code blocks', async () => {
    await freshChat();
    await ask('Reply with a fenced ```js code block containing exactly: console.log(42)');
    assert.ok((await h.count('.msg.assistant pre code')) > 0, 'a rendered code block');
    assert.match(String(await h.text('.msg.assistant pre code')), /console\.log\(42\)/);
  });

  it('a reasoning model shows its thinking in a collapsible block', async () => {
    // A scripted model that streams reasoning_content before its answer: proves
    // the whole thinking path without loading a large reasoning model.
    const fake = new FakeThinker();
    await fake.start();
    try {
      await useServer(fake.url);
      await freshChat({ model: THINKER_MODEL });
      const reply = await ask('What is 17 * 23?');
      assert.match(reply, /391/);
      await until(async () => (await h.count('.part-reasoning')) > 0, 10_000, 'the thinking block');
      assert.match(String(await h.text('.part-reasoning')), /17 times 20/, 'the reasoning text streamed into the block');
    } finally {
      await useServer(BASE_URL);
      await fake.stop();
    }
  });

  it('reports generation speed and fills the context meter', async () => {
    await freshChat();
    // Long enough to stream as many deltas: a one-chunk reply has no rate.
    await ask('Count from 1 to 40, separated by spaces.');
    await until(async () => (await h.count('.msg.assistant .gen-stat')) > 0, 10_000, 'the generation stat');
    const meter = String(await h.attr('#ctx-meter .ctx-fill', 'style'));
    assert.match(meter, /width:\s*[1-9]/, `the context meter moved (${meter})`);
  });
});
