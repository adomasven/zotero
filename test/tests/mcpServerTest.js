"use strict";

describe("Zotero.Server.MCP", function () {
	beforeEach(function () {
		Zotero.Prefs.set('mcp.enabled', true);
	});
	
	after(function () {
		Zotero.Prefs.clear('mcp.enabled');
	});
	
	describe("/mcp", function () {
		it("should return 404 while MCP is disabled", async function () {
			Zotero.Prefs.set('mcp.enabled', false);
			let { status } = await postMCP({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
			// zotero-mcp-stdio reports a 404 as old or turned off
			assert.equal(status, 404);
		});
		
		it("should only declare known permissions, with a libraryID argument for library ones", async function () {
			let { EDIT_LIBRARY, DELETE, EDIT_SETTINGS, INSTALL_STYLES } = Zotero.MCP.Permissions;
			for (let tool of await Zotero.MCP.getTools()) {
				let permission = tool._meta?.[Zotero.MCP.PERMISSION_META];
				if (!permission) continue;
				assert.include([EDIT_LIBRARY, DELETE, EDIT_SETTINGS, INSTALL_STYLES], permission, tool.name);
				if (permission == EDIT_LIBRARY || permission == DELETE) {
					assert.equal(tool.inputSchema.properties.libraryID?.type, 'integer', tool.name);
				}
			}
		});
		
		it("should list the tools from tools.json", async function () {
			let { body } = await postMCP({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
			let names = body.result.tools.map(tool => tool.name);
			assert.includeMembers(names, ['zotero_status', 'zotero_search']);
			assert.deepEqual(body.result.tools, await Zotero.MCP.getTools());
			assert.equal(body.result.resultType, 'complete');
			assert.equal(body.result.ttlMs, 0);
			assert.equal(body.result.cacheScope, 'public');
			assert.deepEqual(body.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'Zotero', version: Zotero.version });
		});
		
		it("should describe itself to server/discover, with the instructions from tools.json", async function () {
			let { status, body } = await postMCP({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
			assert.equal(status, 200);
			let { supportedVersions, capabilities, instructions, resultType, _meta } = body.result;
			assert.deepEqual(supportedVersions, ['2026-07-28']);
			assert.deepEqual(capabilities, { tools: {} });
			assert.match(instructions, /^Zotero is the user's reference manager/);
			assert.equal(resultType, 'complete');
			assert.equal(_meta['io.modelcontextprotocol/serverInfo'].name, 'Zotero');
		});
		
		it("should answer a method it doesn't implement with a 404 and a JSON-RPC error", async function () {
			let { status, body } = await postMCP({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
			assert.equal(status, 404);
			assert.equal(body.id, 1);
			assert.equal(body.error.code, -32601);
		});
		
		it("should return tool results as structured content", async function () {
			let { result } = await callMCPTool('zotero_status', {});
			assert.equal(result.resultType, 'complete');
			assert.notOk(result.isError);
			assert.equal(result.structuredContent.zoteroVersion, Zotero.version);
		});
		
		it("should report arguments that don't match the input schema as a tool error", async function () {
			let { result } = await callMCPTool('zotero_search', { query: 'a', limit: 0, colour: 'red' });
			assert.isTrue(result.isError);
			assert.match(result.content[0].text, /^Invalid arguments: /);
			assert.match(result.content[0].text, /\/limit/);
			assert.match(result.content[0].text, /colour/);
			assert.notProperty(result, 'structuredContent');
		});
		
		it("should identify the AI app by its clientInfo name", async function () {
			let { result } = await callMCPTool('zotero_status', {});
			assert.equal(result.structuredContent.client, 'test-client');
		});
		
		it("should refuse tool calls from an app that doesn't name itself", async function () {
			for (let clientInfo of [null, { version: '1.0' }, { name: ' ', version: '1.0' }]) {
				let { result } = await callMCPTool('zotero_status', {}, clientInfo);
				assert.isTrue(result.isError, JSON.stringify(clientInfo));
				assert.match(result.content[0].text, /didn't identify itself/);
			}
		});
		
		it("should return a JSON-RPC error for an unknown tool", async function () {
			let { error } = await callMCPTool('zotero_delete_everything', {});
			assert.equal(error.code, -32602);
		});
		
		it("should reject an unsupported protocol version, listing the supported one", async function () {
			let { status, body } = await postMCP(
				{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } },
				{ 'MCP-Protocol-Version': '2025-11-25' }
			);
			assert.equal(status, 400);
			assert.equal(body.id, 1);
			assert.equal(body.error.code, -32022);
			assert.deepEqual(body.error.data, { supported: ['2026-07-28'], requested: '2025-11-25' });
		});
		
		it("should reject requests whose metadata headers are missing or don't match the body", async function () {
			let call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zotero_status', arguments: {} } };
			let cases = [
				[call, { 'MCP-Protocol-Version': null }, /MCP-Protocol-Version header is missing/],
				[call, { 'Mcp-Method': null }, /Mcp-Method header is missing/],
				[call, { 'Mcp-Name': null }, /Mcp-Name header is missing/],
				[call, { 'Mcp-Method': 'tools/list' }, /Mcp-Method header value 'tools\/list' does not match body value 'tools\/call'/],
				[call, { 'Mcp-Name': 'zotero_search' }, /Mcp-Name header value 'zotero_search' does not match/],
				[
					{ ...call, params: { ...call.params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } },
					{},
					/MCP-Protocol-Version header value '2026-07-28' does not match body value '2025-11-25'/,
				],
			];
			for (let [request, headers, message] of cases) {
				let { status, body } = await postMCP(request, headers);
				assert.equal(status, 400, JSON.stringify(headers));
				assert.equal(body.id, 1);
				assert.equal(body.error.code, -32020);
				assert.match(body.error.message, message);
			}
		});
		
		it("should decode a Base64 Mcp-Name before comparing it", async function () {
			let { status, body } = await postMCP(
				{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zotero_status', arguments: {}, _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0' } } } },
				{ 'Mcp-Name': `=?base64?${btoa('zotero_status')}?=` }
			);
			assert.equal(status, 200);
			assert.notOk(body.result.isError);
		});
		
		it("should accept notifications without a response body", async function () {
			let { status } = await postMCP({ jsonrpc: '2.0', method: 'notifications/cancelled' });
			assert.equal(status, 202);
			
			let { body } = await postMCP({ jsonrpc: '2.0', method: 'notifications/cancelled' }, { 'Mcp-Method': null });
			assert.equal(body.error.code, -32020);
			assert.match(body.error.message, /Mcp-Method header is missing/);
		});
	});
	
	describe("Zotero.MCP#install()", function () {
		let binDir;
		
		beforeEach(async function () {
			binDir = await getTempDirectory();
			sinon.stub(Zotero.MCP, 'getBinDir').returns(binDir);
		});
		
		afterEach(async function () {
			Zotero.MCP.getBinDir.restore();
			await IOUtils.remove(Zotero.MCP.getSidecarPath(), { ignoreAbsent: true });
		});
		
		it("should copy tools.json next to the binary", async function () {
			await Zotero.MCP.install();
			let tools = await IOUtils.readJSON(PathUtils.join(binDir, 'tools.json'));
			assert.deepEqual(tools.tools, await Zotero.MCP.getTools());
		});
		
		it("should write the port and launch command to the profile", async function () {
			await Zotero.MCP.install();
			let sidecar = await IOUtils.readJSON(Zotero.MCP.getSidecarPath());
			assert.equal(sidecar.version, 1);
			assert.equal(sidecar.port, Zotero.Server.port);
			assert.equal(sidecar.zoteroVersion, Zotero.version);
			assert.isTrue(await IOUtils.exists(sidecar.launch.command), sidecar.launch.command);
		});
		
		it("should install the bundled binary when the build includes it", async function () {
			let bundled = PathUtils.join(
				Services.dirsvc.get('XREExeF', Ci.nsIFile).parent.path,
				Zotero.MCP.BINARY_NAME
			);
			if (!await IOUtils.exists(bundled)) {
				this.skip();
			}
			await Zotero.MCP.install();
			let installed = PathUtils.join(binDir, Zotero.MCP.BINARY_NAME);
			assert.equal((await IOUtils.stat(installed)).size, (await IOUtils.stat(bundled)).size);
			if (!Zotero.isWin) {
				assert.equal((await IOUtils.stat(installed)).permissions & 0o111, 0o111);
			}
		});
	});
});
