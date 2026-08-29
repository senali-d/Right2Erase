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
const maxResults = positiveInteger(process.env.MCP_STORAGE_MAX_RESULTS || process.env.MCP_MAX_RESULTS, 1000);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function objectMetadata(object) {
  return { key: object.name, size: object.size, etag: object.etag, last_modified: object.lastModified };
}

/**
 * Lists object metadata, or refuses.
 *
 * This used to return `{ truncated: true }` at the cap and leave the caller to
 * notice. A partial object listing is indistinguishable from a complete one to
 * anything that does not check that flag, and planning an erasure from it
 * silently leaves the subject's files in place - so the cap is now a refusal
 * threshold rather than a silent stop. The bound itself stays: refusing is not
 * the same as loading an unbounded listing into memory.
 *
 * `truncated` is still reported, always false, so the response shape does not
 * change for existing readers.
 */
function listObjects(prefix, query) {
  return new Promise((resolve, reject) => {
    const objects = [];
    const needle = query?.toLowerCase();
    let overflowed = false;
    let settled = false;
    const stream = client.listObjectsV2(bucket, prefix, true);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ objects, truncated: false, limit: maxResults });
    };

    const describe = () => (query ? `search "${query}"` : `prefix "${prefix}"`);

    stream.on('data', (object) => {
      if (needle && !object.name.toLowerCase().includes(needle)) return;
      if (objects.length >= maxResults) {
        overflowed = true;
        stream.destroy();
        finish(new Error(`storage listing for ${describe()} exceeds the ${maxResults}-object limit; refusing to return a partial set that would plan an incomplete erasure. Narrow the query, or raise MCP_STORAGE_MAX_RESULTS.`));
        return;
      }
      objects.push(objectMetadata(object));
    });
    stream.on('end', () => finish());
    stream.on('error', (error) => {
      // Destroying the stream after overflowing is our own stop; the refusal
      // has already been delivered, so don't overwrite it with the resulting
      // premature-close error.
      if (overflowed) return;
      finish(error);
    });
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
  tool('storage_list_objects', 'List all object metadata under a prefix, or fail. Use uploads/acct_<id>/ to find linked and orphaned subject files. The listing is never partial: if it would exceed the server limit the call fails rather than returning a subset, so a result can always be planned from as complete.', {
    prefix: z.string().max(500).default(''),
  }, async ({ prefix }) => result(await listObjects(prefix)));
  tool('storage_get_object_metadata', 'Read metadata for one object. Object content is never returned.', {
    object_key: z.string().min(1).max(1000),
  }, async ({ object_key }) => result(await statObject(object_key)));
  tool('storage_search_objects', 'Search all object keys by a required substring, returning metadata only. Like storage_list_objects, an oversized result fails rather than returning a subset.', {
    query: z.string().min(1).max(200),
  }, async ({ query }) => result(await listObjects('', query)));
  return server;
}

if (process.env.MCP_TRANSPORT === 'http') {
  startHttpMcp(createServer, { name: 'shopkart-storage', port: Number(process.env.MCP_STORAGE_PORT || process.env.MCP_PORT || 4013) });
} else {
  await createServer().connect(new StdioServerTransport());
}
