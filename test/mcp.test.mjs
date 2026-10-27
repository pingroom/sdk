import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom } from '../dist/index.js';
import { recorder } from './helpers.mjs';

test('mcp.callTool initializes once, notifies the server, and sends the negotiated protocol header', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/mcp': ({ init }) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return {
          body: {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'pingroom', version: '1.0.0' },
            },
          },
        };
      }
      if (body.method === 'notifications/initialized') {
        return { status: 202 };
      }
      if (body.method === 'tools/list') {
        return { body: { jsonrpc: '2.0', id: body.id, result: { tools: [] } } };
      }
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '{}' }] },
        },
      };
    },
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const r = await pr.mcp.callTool('list_rooms', { limit: 5 });
  await pr.mcp.listTools();

  assert.equal(r.content[0].type, 'text');
  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body).method), [
    'initialize',
    'notifications/initialized',
    'tools/call',
    'tools/list',
  ]);
  const toolCall = JSON.parse(calls[2].init.body);
  assert.equal(toolCall.jsonrpc, '2.0');
  assert.deepEqual(toolCall.params, { name: 'list_rooms', arguments: { limit: 5 } });
  assert.equal(calls[0].init.headers['MCP-Protocol-Version'], undefined);
  assert.equal(calls[1].init.headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(calls[2].init.headers['MCP-Protocol-Version'], '2025-06-18');
});
