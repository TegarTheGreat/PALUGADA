/**
 * A real browser, for the tests of what the console looks like rather than
 * what it says (the analysis of 3 October, §2.3 item 8: at a phone's width,
 * tables ran off the screen and badges were cut to "1..").
 *
 * Chromium, driven over its DevTools protocol with Node's own WebSocket and
 * fetch, so no dependency is added for it. Found where it is usually
 * installed, or at PALUGADA_CHROMIUM; with none, the tests that need it skip
 * and say why.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromium } from '../../src/browser/chromium.ts';

/** Where a Chromium is, or null: the one the platform itself would use. */
export function chromium(): string | null {
  return findChromium(process.env);
}

export interface Page {
  goto(url: string): Promise<void>;
  /** An expression's value, awaited if it is a promise. */
  evaluate<T>(expression: string): Promise<T>;
  /** Waits until the expression is true, and fails saying what it waited for. */
  waitFor(expression: string, what: string, timeoutMs?: number): Promise<void>;
  /** Types into whatever has the focus, one key at a time, as a person does. */
  type(text: string): Promise<void>;
  close(): Promise<void>;
}

export async function openPage(
  executable: string,
  viewport: { width: number; height: number },
  /** The language the browser is set to, as a person sets it: `id`, `pt-BR`. */
  language?: string,
): Promise<Page> {
  const profile = await mkdtemp(join(tmpdir(), 'palugada-browser-'));
  const process_: ChildProcess = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    ...(language ? [`--lang=${language}`, `--accept-lang=${language}`] : []), 'about:blank',
  ], { stdio: 'ignore' });

  // The port it chose, which it writes into its profile once it listens.
  let port = '';
  for (let tries = 0; tries < 100 && !port; tries += 1) {
    port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] ?? '';
    if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) throw new Error(`${executable} did not start listening for DevTools`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let sent = 0;
  const waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    sent += 1;
    waiting.set(sent, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result as T)));
    socket.send(JSON.stringify({ id: sent, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: true });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const answer = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (answer.exceptionDetails) throw new Error(`${expression}: ${answer.exceptionDetails.text}`);
    return answer.result.value;
  };

  return {
    goto: async (url) => { await send('Page.navigate', { url }); },
    evaluate,
    waitFor: async (expression, what, timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (await evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`waited ${timeoutMs} ms for ${what}`);
    },
    type: async (text) => {
      for (const key of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      }
    },
    close: async () => {
      socket.close();
      process_.kill();
      await new Promise((resolve) => process_.once('exit', resolve));
      await rm(profile, { recursive: true, force: true });
    },
  };
}
