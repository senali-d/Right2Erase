#!/usr/bin/env node
/** Read-only ShopKart MinIO MCP adapter. It exposes metadata, never object writes/deletes. */
import * as Minio from 'minio';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startHttpMcp } from './http-transport.js';

const client = new Minio.Client({
  endPoint: process.env.MINIO_HOST || 'localhost',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'shopkart',
  secretKey: process.env.MINIO_SECRET_KEY || 'shopkart123',
});
const bucket = process.env.MINIO_BUCKET || 'shopkart-uploads';
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function listObjects(prefix) {
  return new Promise((resolve, reject) => {
    const objects = [];
    const stream = client.listObjectsV2(bucket, prefix, true);
    stream.on('data', (object) => objects.push({ key: object.name, size: object.size, etag: object.etag, last_modified: object.lastModified }));
    stream.on('end', () => resolve(objects));
    stream.on('error', reject);
  });
}

function statObject(key) {
  return client.statObject(bucket, key).then((stat) => ({
    key, size: stat.size, etag: stat.etag, content_type: stat.metaData?.['content-type'] || null,
    metadata: stat.metaData || {}, last_modified: stat.lastModified,
  }));
}

function createServer() {
  const server = new McpServer({ name: 'shopkart-storage', version: '1.0.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, {
    description, inputSchema, annotations: readOnly,
  }, handler);
  tool('storage_list_objects', 'List object metadata under a prefix. Use uploads/acct_<id>/ to find linked and orphaned subject files.', {
    prefix: z.string().max(500).default(''),
  }, async ({ prefix }) => result(await listObjects(prefix)));
  tool('storage_get_object_metadata', 'Read metadata for one object. Object content is never returned.', {
    object_key: z.string().min(1).max(1000),
  }, async ({ object_key }) => result(await statObject(object_key)));
  tool('storage_search_objects', 'Search object keys by a required substring, returning metadata only.', {
    query: z.string().min(1).max(200),
  }, async ({ query }) => {
    const objects = await listObjects('');
    const needle = query.toLowerCase();
    return result(objects.filter((object) => object.key.toLowerCase().includes(needle)));
  });
  return server;
}

if (process.env.MCP_TRANSPORT === 'http') {
  startHttpMcp(createServer, { name: 'shopkart-storage', port: Number(process.env.MCP_PORT || 4013) });
} else {
  await createServer().connect(new StdioServerTransport());
}
