import { connectMcp, callTool } from './mcp-client.ts';

// pnpm mcp:call <tool> '<json args>'   |   pnpm mcp:call --resource <uri>   |   pnpm mcp:call --list
const argv = process.argv.slice(2);
if (!argv.length) { console.error('usage: mcp-call <tool> [json] | --resource <uri> | --list'); process.exit(2); }
const client = await connectMcp();
try {
  if (argv.includes('--list')) { console.log(JSON.stringify({ tools: (await client.listTools()).tools.map((t) => t.name), resources: (await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate), prompts: (await client.listPrompts()).prompts.map((p) => p.name) }, null, 2)); }
  else if (argv.includes('--resource')) { const r = await client.readResource({ uri: argv[argv.indexOf('--resource') + 1] }); console.log(JSON.stringify(r.contents.map((c) => ({ uri: c.uri, mimeType: c.mimeType, text: typeof c.text === 'string' ? c.text.slice(0, 2000) : undefined, blobBytes: typeof c.blob === 'string' ? Math.round(c.blob.length * 0.75) : undefined })), null, 2)); }
  else {
    const [tool, json] = argv;
    const r = await callTool(client, tool, json ? JSON.parse(json) : {});
    if (r.image) console.log(JSON.stringify({ image: true, bytes: Math.round(r.image.length * 0.75) }));
    else console.log(r.isError ? `ERROR ${r.text}` : r.text);
    if (r.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
