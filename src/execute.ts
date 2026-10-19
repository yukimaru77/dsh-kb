import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface ExecuteOptions { cwd: string; signal: AbortSignal }
export type KbExecutor = (argv: readonly string[], options: ExecuteOptions) => Promise<string>;
export class KbCommandError extends Error {}

/** Run only the configured executable and explicit argv; never interpolate a shell command. */
export function executor(command: string, timeoutMs = 120_000, maxBufferBytes = 128 * 1024 * 1024): KbExecutor {
  return async (argv, { cwd, signal }) => {
    try {
      const { stdout } = await execute(command, [...argv], { cwd, signal, timeout: timeoutMs, maxBuffer: maxBufferBytes, encoding: 'utf8' });
      return stdout;
    } catch (error) {
      if (signal.aborted) throw new KbCommandError('KBの読み込みを中止しました。');
      // Neither stdout nor stderr is reflected: a CLI or parser can include KB content in an error.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') throw new KbCommandError('kbコマンドが見つかりません。DSH_KB_COMMANDを設定してください。');
      // Only a fixed phrase is matched; the stderr text itself is still never shown.
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      if (stderr.includes('復号済みKBがありません')) {
        throw new KbCommandError('このKBには復号済みの本文がありません。`kb decrypt 名前` で復号してから /kb を実行してください。');
      }
      if (stderr.includes('KBが見つかりません')) throw new KbCommandError('指定したKBが見つかりません。/kb list で名前と保存先を確認してください。');
      if (/unrecognized arguments: --decrypted/.test(stderr)) {
        throw new KbCommandError('kbコマンドが --decrypted に未対応です。kb-repomapを更新してください。');
      }
      throw new KbCommandError('kbコマンドの実行に失敗しました。保存先・名前・実行時間上限を確認してください。');
    }
  };
}
