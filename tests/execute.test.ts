import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executor, KbCommandError } from '../src/execute.ts';

test('CLI failures never expose captured KB stdout or stderr', async () => {
  const run = executor(process.execPath);
  await assert.rejects(run(['-e', 'console.log("PRIVATE_SNAPSHOT"); console.error("PRIVATE_ERROR"); process.exit(2)'],
    { cwd: process.cwd(), signal: new AbortController().signal }), error => {
    assert(error instanceof KbCommandError);
    assert(!String(error).includes('PRIVATE'));
    return true;
  });
});
test('CLI arguments are passed literally and execution is cancellable', async () => {
  const run = executor(process.execPath);
  const literal = '$(printf unintended); spaces';
  const result = await run(['-e', 'console.log(process.argv[1])', literal], { cwd: process.cwd(), signal: new AbortController().signal });
  assert.equal(result.trim(), literal);
  const abort = new AbortController();
  const waiting = run(['-e', 'setTimeout(()=>{}, 60000)'], { cwd: process.cwd(), signal: abort.signal });
  abort.abort();
  await assert.rejects(waiting, /中止/);
});
