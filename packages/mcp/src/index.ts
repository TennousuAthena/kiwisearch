#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeHub, RelayClient } from './bridge';
import { createMcpServer } from './server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function pairingToken(): Promise<string> {
  const directory = process.env.FUSION_HOME ?? join(homedir(), '.fusion-search');
  const file = join(directory, 'token');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const token = (await readFile(file, 'utf8')).trim();
    await chmod(file, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  try {
    const handle = await open(file, 'wx', 0o600);
    await handle.writeFile(token, 'utf8');
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = (await readFile(file, 'utf8')).trim();
    await chmod(file, 0o600);
    return existing;
  }
  console.error(`Fusion Search 配对令牌已保存到 ${file}（权限 0600）。请复制到插件设置的“MCP 桥 → 配对令牌”后保存。`);
  console.error(`配对令牌：${token}`);
  return token;
}

function configuredPort(): number {
  const port = Number(process.env.FUSION_PORT ?? 17345);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FUSION_PORT 必须在 1–65535 之间');
  return port;
}

async function main(): Promise<void> {
  const token = await pairingToken();
  const port = configuredPort();
  const extensionId = process.env.FUSION_EXTENSION_ID;
  const hub = new BridgeHub(token, { port, extensionId });
  let bridge: BridgeHub | RelayClient;
  try {
    await hub.start();
    bridge = hub;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    bridge = await RelayClient.connect(port, token);
  }
  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = async () => {
    if (bridge instanceof BridgeHub) await bridge.close();
    else bridge.close();
    await server.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit()));
  process.once('SIGTERM', () => void close().finally(() => process.exit()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
