import { StdioMcpClient } from './src/mcp/stdio-mcp-client';

async function main() {
  const entry = 'D:/developFile/node_config/nodejs_global/node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js';
  console.log('Starting client with node + absolute path...');
  const client = new StdioMcpClient({
    command: 'node',
    args: [entry],
    startupTimeoutMs: 10000,
    requestTimeoutMs: 10000
  });

  try {
    await client.start();
    console.log('✅ start() succeeded (initialize handshake passed)!');
    const tools = await client.listTools();
    console.log(`✅ listTools() returned ${tools.length} tools:`);
    tools.forEach(t => console.log(`  - ${t.name}`));
  } catch (e: any) {
    console.error('❌ Error:', e.message);
  } finally {
    await client.stop();
  }
}
main();
