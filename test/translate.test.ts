import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EventTranslator,
  textPartId,
  toolPartId,
  v1History,
  v1Permission,
  v1Questions,
  v1ToolInput,
  v1ToolName,
  v2FormAnswer,
  type V2Event,
} from '../src/opencode/translate';

// Payloads captured from a live OpenCode 2.1.4 (paths scrubbed).
const fx = JSON.parse(readFileSync('test/fixtures-v2.json', 'utf8')) as Record<string, V2Event[]> & { history: any[] };

function run(events: V2Event[]) {
  const t = new EventTranslator();
  return { t, out: events.flatMap((e) => t.translate(e)) };
}
const types = (out: Array<{ type: string }>) => out.map((e) => e.type);

test('a tool-using turn becomes assistant message, text, tool parts and idle', () => {
  const { out } = run(fx.toolWrite);
  const tys = types(out);
  assert.ok(tys.includes('message.updated'));
  assert.ok(tys.includes('message.part.delta'));
  assert.equal(tys.at(-1), 'session.idle');
  const tool = out
    .filter((e) => e.type === 'message.part.updated' && (e.properties as any).part.type === 'tool')
    .map((e) => (e.properties as any).part);
  assert.ok(tool.length >= 2, 'tool part updated as it progresses');
  const done = tool.at(-1);
  assert.equal(done.tool, 'write');
  assert.equal(done.state.status, 'completed');
  assert.equal(done.state.input.filePath, done.state.input.path, 'path mirrored to filePath for the webview');
  assert.match(done.state.output, /hello/i);
  // Every tool update for one call lands on the same webview element.
  assert.equal(new Set(tool.map((p) => p.id)).size, 1);
});

test('text deltas and the final part share one part id', () => {
  const { out } = run(fx.toolWrite);
  const delta = out.find((e) => e.type === 'message.part.delta')!.properties as any;
  const finals = out.filter((e) => e.type === 'message.part.updated' && (e.properties as any).part.id === delta.partID);
  assert.ok(finals.length >= 1);
  assert.equal(delta.field, 'text');
});

test('the user bubble appears when the prompt is delivered, not when it is queued', () => {
  const { out } = run(fx.toolWrite);
  const tys = types(out);
  const enq = tys.indexOf('inbox.enqueued');
  const del = tys.indexOf('inbox.delivered');
  assert.ok(enq >= 0 && del > enq);
  const userIdx = out.findIndex((e) => e.type === 'message.updated' && (e.properties as any).info.role === 'user');
  assert.ok(userIdx > del, 'user message follows delivery');
  const userText = out.find(
    (e) => e.type === 'message.part.updated' && (e.properties as any).part.messageID === (out[userIdx].properties as any).info.id,
  );
  assert.match((userText!.properties as any).part.text, /write tool/);
});

test('pending() tracks undelivered inbox items and clears them on delivery', () => {
  const t = new EventTranslator();
  const enq = fx.toolWrite.find((e) => e.type === 'session.inbox.enqueued')!;
  t.translate(enq);
  const sid = enq.data.sessionID;
  assert.equal(t.pending(sid).length, 1);
  assert.equal(t.pending(sid)[0].delivery, 'steer');
  t.translate({ type: 'session.inbox.delivery.changed', data: { sessionID: sid, inboxID: enq.data.inboxID, delivery: 'queue' } });
  assert.equal(t.pending(sid)[0].delivery, 'queue');
  t.translate(fx.toolWrite.find((e) => e.type === 'session.inbox.delivered')!);
  assert.equal(t.pending(sid).length, 0);
});

test('an interrupt reads as a stop (MessageAbortedError) followed by idle', () => {
  const { out } = run(fx.interrupt);
  const err = out.find((e) => e.type === 'session.error')!;
  assert.equal((err.properties as any).error.name, 'MessageAbortedError');
  assert.equal(types(out).at(-1), 'session.idle');
});

test('a failed run surfaces its message through session.error', () => {
  const { out } = run([
    { type: 'session.execution.failed', data: { sessionID: 's', error: { type: 'provider.no-route', message: 'Cannot initialize x' } } },
  ]);
  assert.deepEqual(types(out), ['session.error', 'session.idle']);
  assert.equal((out[0].properties as any).error.data.message, 'Cannot initialize x');
});

test('permission asks map to the 1.x request and replies resolve it by id', () => {
  const { out } = run(fx.permission);
  const asked = out.find((e) => e.type === 'permission.asked')!.properties as any;
  assert.equal(asked.permission, 'edit');
  assert.ok(asked.metadata.filePath, 'file path surfaced for the card');
  assert.match(String(asked.metadata.diff), /\+/, 'patch surfaced as a diff');
  const replied = out.find((e) => e.type === 'permission.replied')!.properties as any;
  assert.equal(replied.id, asked.id);
});

test('shell permissions show the command', () => {
  const p = v1Permission({ id: 'p', sessionID: 's', action: 'shell', resources: ['rm -rf build'] });
  assert.equal(p.permission, 'bash');
  assert.equal((p.metadata as any).command, 'rm -rf build');
});

test('question forms map to the picker and answers back to field values', () => {
  const { t, out } = run(fx.question);
  const asked = out.find((e) => e.type === 'question.asked')!.properties as any;
  assert.equal(asked.questions.length, 1);
  assert.equal(asked.questions[0].options[1].label, 'Blue');
  assert.ok(types(out).includes('question.replied'));
  const form = fx.question.find((e) => e.type === 'form.created')!.data.form;
  assert.deepEqual(v2FormAnswer(form, [['Blue']]), { q0: 'Blue' });
  assert.deepEqual(v2FormAnswer(form, [['something else']]), { q0: 'something else' }, 'custom text passes through');
  // A replied form is forgotten.
  assert.equal(t.formFor(asked.id), undefined);
});

test('multiselect questions answer with an array of option values', () => {
  const form = {
    fields: [{ key: 'q0', title: 'Pick', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
  };
  assert.equal(v1Questions(form)[0].multiple, true);
  assert.deepEqual(v2FormAnswer(form, [['A', 'B']]), { q0: ['a', 'b'] });
});

test('a cancelled question is reported as rejected', () => {
  const { out } = run(fx.questionCancel);
  assert.ok(types(out).includes('question.rejected'));
});

test('non-question forms are not shown as questions', () => {
  const { out } = run([{ type: 'form.created', data: { form: { id: 'f', sessionID: 's', metadata: { kind: 'mcp' }, fields: [] } } }]);
  assert.equal(out.length, 0);
});

test('compaction completion reports session.compacted with the summary', () => {
  const { out } = run(fx.compaction);
  assert.equal(out[0].type, 'session.compacted');
  assert.match(String((out[0].properties as any).summary), /Objective/);
});

test('history comes back oldest first with user text, tool and step-finish parts', () => {
  const sid = 'ses_x';
  const h = v1History(sid, fx.history);
  assert.deepEqual(
    h.map((m) => m.info.role),
    ['user', 'assistant', 'assistant'],
    'idle markers are not chat',
  );
  assert.match((h[0].parts[0] as any).text, /write tool/);
  const tool = h[1].parts.find((p) => p.type === 'tool') as any;
  assert.equal(tool.state.status, 'completed');
  assert.equal(tool.id, toolPartId(h[1].info.id, tool.callID), 'same id as the live part');
  assert.equal(h[2].parts.find((p) => p.type === 'text')!.id, textPartId(h[2].info.id, 0));
  assert.equal(h[2].parts.at(-1)!.type, 'step-finish');
  assert.ok(h[2].info.tokens, 'tokens kept for the context meter');
});

test('a compaction in history becomes a marker plus the summary turn the webview folds', () => {
  const h = v1History('s', [
    { id: 'm1', type: 'user', text: 'hi', time: { created: 1 } },
    { id: 'c1', type: 'compaction', text: '## Objective\n- x', time: { created: 2 } },
    { id: 'm2', type: 'user', text: 'next', time: { created: 3 } },
  ]);
  assert.deepEqual(
    h.map((m) => [m.info.role, m.parts[0]?.type]),
    [
      ['user', 'text'],
      ['user', 'compaction'],
      ['assistant', 'text'],
      ['user', 'text'],
    ],
  );
});

test('renamed tools map back to the names the webview special-cases', () => {
  assert.equal(v1ToolName('shell'), 'bash');
  assert.equal(v1ToolName('todo'), 'todowrite');
  assert.equal(v1ToolName('subagent'), 'task');
  assert.equal(v1ToolName('read'), 'read');
  assert.equal(v1ToolInput('subagent', { agent: 'reviewer', prompt: 'x' }).subagent_type, 'reviewer');
});
