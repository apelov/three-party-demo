#!/usr/bin/env node
// The adapter MCP server, packaged so the Maurice runtime can launch it with
// npx from this directory (the MCP definition's command allowlist is
// npx/uvx/go/docker). All behavior lives in ../adapter-mcp.mjs.
import '../adapter-mcp.mjs';
