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

  const exited = new Promise<void>((resolve) => process_.once('exit', () => resolve()));
  const stop = async () => {
    // A browser that already exited has nothing to wait for; one that will not
    // stop is killed outright rather than left to hold the test file open.
    if (process_.exitCode === null && process_.signalCode === null) {
      process_.kill();
      const killed = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]);
      if (!killed) process_.kill('SIGKILL');
    }
    // Chromium's own helpers may still be writing into the profile as the
    // browser exits; a directory that is not empty yet is tried again, and
    // one that stays so does not fail a test of something else.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  };

  // Everything from here to a page it can be driven on either succeeds or
  // stops the browser: a failure that left it running would keep the test
  // file alive after its tests ended, and CI waits six hours for that.
  let socket: WebSocket;
  try {
    // The port it chose, which it writes into its profile once it listens. A
    // first start on a fresh machine builds its font cache first, which takes
    // a while (cf. LAUNCH_WAIT_MS in src/browser/cdp.ts).
    const deadline = Date.now() + 60_000;
    let port = '';
    while (!port && Date.now() < deadline && process_.exitCode === null) {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] ?? '';
      if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new Error(`${executable} did not start listening for DevTools`);
    // The port is written before the first tab is listed: asked too early,
    // the list has no page in it yet.
    let page: { webSocketDebuggerUrl: string } | undefined;
    while (!page && Date.now() < deadline) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      page = targets.find((target) => target.type === 'page');
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error(`${executable} listed no page to drive`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
  } catch (error) {
    await stop();
    throw error;
  }

  let sent = 0;
  const waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  // A browser that goes away answers nothing more: what is waiting is told so,
  // rather than waiting for ever.
  socket.addEventListener('close', () => {
    for (const answer of waiting.values()) answer({ error: { message: 'the browser closed its connection' } });
    waiting.clear();
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`${method}: the browser closed its connection`));
      return;
    }
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
      await stop();
    },
  };
}
