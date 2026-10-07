// Installed-server smoke test; --exercise also runs one turn in a disposable project.
// Never prints account identifiers, tokens, or assistant output.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exercise = process.argv.includes('--exercise');
const child = spawn(process.env.CODEX_PRISM_BINARY || 'codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
let next = 1, completed, project, thread;
const pending = new Map();
const completion = new Promise(resolve => { completed = resolve; });
const lines = createInterface({ input: child.stdout });
function write(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'turn/completed') completed(message.params.turn);
  if (message.method && message.id !== undefined) {
    write({ id: message.id, error: { code: -32601, message: 'Smoke test cannot approve external actions' } });
    return;
  }
  const p = pending.get(message.id);
  if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
});
child.stderr.resume();
child.on('error', e => { for (const p of pending.values()) p.reject(e); });
child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Codex exited')); completed({ status: 'failed' }); });
const timeout = setTimeout(() => { console.error('Protocol check timed out'); child.kill(); process.exitCode = 1; }, exercise ? 180000 : 30000);
function call(method, params) { const id = next++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); write({ id, method, params }); }); }
try {
  await call('initialize', { clientInfo: { name: 'codex_prism_check', title: 'Codex-Prism protocol check', version: '0.1.0' }, capabilities: {} });
  write({ method: 'initialized' });
  const [account, models] = await Promise.all([call('account/read', { refreshToken: false }), call('model/list', {})]);
  const result = { initialized: true, authenticated: !!account.account, models: models.data?.length ?? 0 };
  if (exercise) {
    project = await mkdtemp(join(tmpdir(), 'codex-prism-smoke-'));
    const started = await call('thread/start', { cwd: project, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', config: { 'sandbox_workspace_write.network_access': false }, developerInstructions: 'This is a disposable integration test. Work only in the project directory. Do not access the network or any user files.' });
    thread = started.thread.id;
    await call('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Create smoke.txt in the project directory with exactly the text codex-prism-ok followed by a newline. Do nothing else.' }] });
    const turn = await completion;
    if (turn.status !== 'completed') throw new Error(`Smoke turn did not complete (${turn.status})`);
    if ((await readFile(join(project, 'smoke.txt'), 'utf8')).trim() !== 'codex-prism-ok') throw new Error('Smoke file contents differ');
    const read = await call('thread/read', { threadId: thread, includeTurns: true });
    if (!read.thread.turns.length) throw new Error('Completed conversation could not be read');
    await call('thread/resume', { threadId: thread, cwd: project, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
    result.fileEdit = true; result.sessionResume = true;
  }
  console.log(JSON.stringify(result));
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  if (thread) { try { await call('thread/archive', { threadId: thread }); } catch {} }
  clearTimeout(timeout); lines.close(); child.kill();
  if (project) await rm(project, { recursive: true, force: true });
}
