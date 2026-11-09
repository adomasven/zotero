"use strict";

describe("Zotero.MCP.AppConfig", function () {
	let { Apps, AppConfig } = Zotero.MCP;
	let home, binary;
	
	beforeEach(async function () {
		home = await getTempDirectory();
		sinon.stub(Apps, 'getHomeDir').returns(home);
		sinon.stub(Apps, 'isInstalled').resolves(true);
		// No PATH or XDG directories, so only the temporary home counts
		sinon.stub(Apps, 'getEnv').returns('');
		let binDir = await getTempDirectory();
		sinon.stub(Zotero.MCP, 'getBinDir').returns(binDir);
		binary = Zotero.MCP.getBinaryPath();
		await IOUtils.writeUTF8(binary, '');
	});
	
	afterEach(function () {
		sinon.restore();
	});
	
	function getApp(id) {
		return Apps.getAll().find(app => app.id == id);
	}
	
	describe("#getStatus()", function () {
		it("should report apps that aren't installed as not installed, even with settings", async function () {
			Apps.isInstalled.resolves(false);
			let app = getApp('claude-code');
			await IOUtils.writeJSON(app.config, { mcpServers: {} });
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_NOT_INSTALLED);
		});
		
		it("should count an entry under another name as connected, and not add a second", async function () {
			let app = getApp('cursor');
			await IOUtils.writeJSON(app.config, { mcpServers: { 'my-zotero': { command: '/elsewhere/zotero-mcp-stdio' } } });
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONNECTED);
			await AppConfig.connect(app);
			assert.deepEqual(Object.keys((await IOUtils.readJSON(app.config)).mcpServers), ['my-zotero']);
		});
		
		it("should not replace a different server named zotero", async function () {
			let app = getApp('cursor');
			await IOUtils.writeJSON(app.config, { mcpServers: { zotero: { command: 'npx', args: ['zotero-mcp'] } } });
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONFLICT);
			let error;
			try {
				await AppConfig.connect(app);
			}
			catch (e) {
				error = e;
			}
			assert.ok(error);
			assert.equal((await IOUtils.readJSON(app.config)).mcpServers.zotero.command, 'npx');
		});
	});

	
	describe("#getConfigPath()", function () {
		it("should use the settings file that exists", async function () {
			let app = getApp('amp');
			let jsonc = PathUtils.join(home, '.config', 'amp', 'settings.jsonc');
			assert.equal(await AppConfig.getConfigPath(app), PathUtils.join(home, '.config', 'amp', 'settings.json'));
			await IOUtils.makeDirectory(PathUtils.parent(jsonc), { createAncestors: true });
			await IOUtils.writeUTF8(jsonc, '{\n  // mine\n}\n');
			await AppConfig.connect(app);
			assert.equal(
				Zotero.MCP.JSONC.parse(await IOUtils.readUTF8(jsonc))['amp.mcpServers'].zotero.command,
				binary
			);
		});
	});

	
	describe("#connect() and #disconnect() with JSON", function () {
		it("should add and remove a JSON entry, keeping other servers and settings", async function () {
			let app = getApp('claude-code');
			let other = { command: 'other-server', args: ['x'] };
			await IOUtils.writeJSON(app.config, { theme: 'dark', mcpServers: { other } });
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_NOT_CONNECTED);
			
			await AppConfig.connect(app);
			let json = await IOUtils.readJSON(app.config);
			assert.equal(json.theme, 'dark');
			assert.deepEqual(json.mcpServers.other, other);
			assert.equal(json.mcpServers.zotero.command, binary);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONNECTED);
			
			await AppConfig.disconnect(app);
			json = await IOUtils.readJSON(app.config);
			assert.deepEqual(json, { theme: 'dark', mcpServers: { other } });
		});
		
		it("should edit settings with comments and trailing commas, keeping the rest as it was", async function () {
			let app = getApp('zed');
			let text = '// Zed settings\n{\n  "ui_font_size": 16, // big\n  "context_servers": {\n    /* none yet */\n  },\n}\n';
			await IOUtils.makeDirectory(PathUtils.parent(app.config), { createAncestors: true });
			await IOUtils.writeUTF8(app.config, text);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_NOT_CONNECTED);
			
			await AppConfig.connect(app);
			let edited = await IOUtils.readUTF8(app.config);
			assert.isTrue(edited.startsWith('// Zed settings\n{\n  "ui_font_size": 16, // big\n'), edited);
			assert.include(edited, '/* none yet */');
			assert.deepEqual(
				Zotero.MCP.JSONC.parse(edited),
				{ ui_font_size: 16, context_servers: { zotero: { command: binary, args: [] } } } // eslint-disable-line camelcase
			);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONNECTED);
			
			await AppConfig.disconnect(app);
			assert.equal(await IOUtils.readUTF8(app.config), text);
		});
		
		it("should keep comments in an empty one-line object", async function () {
			let app = getApp('cursor');
			await IOUtils.makeDirectory(PathUtils.parent(app.config), { createAncestors: true });
			await IOUtils.writeUTF8(app.config, '{"mcpServers": { /* keep me */ }}');
			await AppConfig.connect(app);
			let edited = await IOUtils.readUTF8(app.config);
			assert.include(edited, '/* keep me */');
			assert.equal(Zotero.MCP.JSONC.parse(edited).mcpServers.zotero.command, binary);
		});
		
		it("should keep the permissions of a private settings file", async function () {
			if (Zotero.isWin) {
				this.skip();
			}
			let app = getApp('claude-code');
			await IOUtils.writeJSON(app.config, { mcpServers: {} });
			await IOUtils.setPermissions(app.config, 0o600, false);
			await AppConfig.connect(app);
			assert.equal((await IOUtils.stat(app.config)).permissions, 0o600);
			assert.equal((await IOUtils.readJSON(app.config)).mcpServers.zotero.command, binary);
		});
		
		it("should not change settings it can't parse", async function () {
			let app = getApp('cursor');
			let text = '{ "mcpServers": { "a": } }';
			await IOUtils.makeDirectory(PathUtils.parent(app.config), { createAncestors: true });
			await IOUtils.writeUTF8(app.config, text);
			let error;
			try {
				await AppConfig.connect(app);
			}
			catch (e) {
				error = e;
			}
			assert.ok(error);
			assert.equal(await IOUtils.readUTF8(app.config), text);
		});
		
		it("should recognize opencode's command array as ours", async function () {
			let app = getApp('opencode');
			let config = app.config[0];
			await IOUtils.makeDirectory(PathUtils.parent(config), { createAncestors: true });
			await IOUtils.writeJSON(config, { $schema: 'https://opencode.ai/config.json' });
			await AppConfig.connect(app);
			let json = await IOUtils.readJSON(await AppConfig.getConfigPath(app));
			assert.deepEqual(json.mcp.zotero, { type: 'local', command: [binary] });
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONNECTED);
			await AppConfig.disconnect(app);
			assert.deepEqual(await IOUtils.readJSON(config), { $schema: 'https://opencode.ai/config.json', mcp: {} });
		});
		
		it("should add servers under a nested key and start new files as the app needs", async function () {
			await AppConfig.connect(getApp('openclaw'));
			assert.deepEqual(
				await IOUtils.readJSON(getApp('openclaw').config),
				{ mcp: { servers: { zotero: { command: binary, args: [] } } } }
			);
			await AppConfig.connect(getApp('muse'));
			assert.deepEqual(
				await IOUtils.readJSON(getApp('muse').config),
				{ schema_version: 1, mcpServers: { zotero: { command: binary, args: [], required: false } } } // eslint-disable-line camelcase
			);
		});
	});
	
	describe("#connect() and #disconnect() with Codex TOML", function () {
		it("should add and remove a Codex TOML table, keeping the rest", async function () {
			let app = getApp('codex');
			let rest = 'model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "other"\n';
			await IOUtils.makeDirectory(PathUtils.parent(app.config));
			await IOUtils.writeUTF8(app.config, rest);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_NOT_CONNECTED);
			
			await AppConfig.connect(app);
			let text = await IOUtils.readUTF8(app.config);
			assert.isTrue(text.startsWith(rest), text);
			assert.include(text, `[mcp_servers.zotero]\ncommand = ${JSON.stringify(binary)}\n`);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONNECTED);
			
			await AppConfig.disconnect(app);
			assert.equal((await IOUtils.readUTF8(app.config)).trimEnd(), rest.trimEnd());
		});
		
		it("should remove a server's subtables with it, and keep the tables after it", async function () {
			let app = getApp('codex');
			let after = '# Profiles\n[[profiles]]\nname = "keep me"\n';
			await IOUtils.makeDirectory(PathUtils.parent(app.config));
			await IOUtils.writeUTF8(
				app.config,
				`[mcp_servers.zotero]\ncommand = ${JSON.stringify(binary)}\n\n[mcp_servers.zotero.env]\nA = "1"\n\n${after}`
			);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONNECTED);
			await AppConfig.disconnect(app);
			assert.equal(await IOUtils.readUTF8(app.config), after);
		});
		
		it("should recognize a quoted server name, and not add a second", async function () {
			let app = getApp('codex');
			let text = "[mcp_servers.'zotero']\ncommand = \"npx\"\n";
			await IOUtils.makeDirectory(PathUtils.parent(app.config));
			await IOUtils.writeUTF8(app.config, text);
			assert.equal(await AppConfig.getStatus(app), AppConfig.STATUS_CONFLICT);
			let error;
			try {
				await AppConfig.connect(app);
			}
			catch (e) {
				error = e;
			}
			assert.ok(error);
			assert.equal(await IOUtils.readUTF8(app.config), text);
		});
	});
});
