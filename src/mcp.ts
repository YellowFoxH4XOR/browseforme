#!/usr/bin/env bun
/**
 * Stdio MCP server for coding agents. Starts the daemon if needed and forwards every tool call
 * to POST /api/action. stdout carries the protocol: log only to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { action, ensureDaemon } from "./client";
import { buildMcpServer } from "./tools";

export async function serveMcp(): Promise<void> {
  const handle = await ensureDaemon();
  serveStdio(() => buildMcpServer((request) => action(handle, request)), {
    onerror: (error) => console.error(`browseforme mcp: ${error.message}`),
  });
  console.error(`browseforme mcp: connected to daemon on port ${handle.port}`);
}

if (import.meta.main) await serveMcp();
