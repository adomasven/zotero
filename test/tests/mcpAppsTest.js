"use strict";

describe("Zotero.MCP.Apps", function () {
	let { Apps } = Zotero.MCP;
	let home;
	
	beforeEach(async function () {
		home = await getTempDirectory();
		sinon.stub(Apps, 'getHomeDir').returns(home);
		// No PATH or XDG directories, so only the temporary home counts
		sinon.stub(Apps, 'getEnv').returns('');
	});
	
	afterEach(function () {
		sinon.restore();
	});
	
	function getApp(id) {
		return Apps.getAll().find(app => app.id == id);
	}
	
	describe("#getAll()", function () {
		it("should give every app an icon", async function () {
			for (let app of Apps.getAll()) {
				let response = await fetch(app.icon).catch(() => null);
				assert.isTrue(!!response?.ok, `${app.id} has no icon at ${app.icon}`);
			}
		});
	});
	
	describe("#getDisplayName()", function () {
		it("should give known apps' product names", function () {
			assert.equal(Apps.getDisplayName('codex-mcp-client'), 'ChatGPT and Codex');
			assert.equal(Apps.getDisplayName('Visual Studio Code'), 'VS Code and Copilot CLI');
			assert.equal(Apps.getDisplayName('Zed'), 'Zed');
			// Qwen Code's name includes the server's name
			assert.equal(Apps.getDisplayName('qwen-cli-mcp-client-my-zotero'), 'Qwen Code');
			assert.equal(Apps.getDisplayName('some-agent'), 'some-agent');
		});
	});
	
	describe("#isInstalled()", function () {
		it("should detect command-line tools where installers put them, not by their settings", async function () {
			let app = getApp('gemini-cli');
			await IOUtils.makeDirectory(PathUtils.join(home, '.gemini'));
			assert.isFalse(await Apps.isInstalled(app));
			// Installed with npm under nvm, which apps not started from a shell don't have in PATH
			let bin = PathUtils.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin');
			await IOUtils.makeDirectory(bin, { createAncestors: true });
			await IOUtils.writeUTF8(PathUtils.join(bin, Zotero.isWin ? 'gemini.cmd' : 'gemini'), '');
			assert.isTrue(await Apps.isInstalled(app));
			
			let cline = getApp('cline');
			assert.isFalse(await Apps.isInstalled(cline));
			await IOUtils.makeDirectory(PathUtils.join(home, '.vscode', 'extensions', 'saoudrizwan.claude-dev-3.40.0'), { createAncestors: true });
			assert.isTrue(await Apps.isInstalled(cline));
			
			// The classic ChatGPT app has the same name but doesn't read Codex's settings
			if (Zotero.isMac) {
				let plist = PathUtils.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist');
				await IOUtils.makeDirectory(PathUtils.parent(plist), { createAncestors: true });
				let write = id => IOUtils.writeUTF8(plist, `<plist><dict><key>CFBundleIdentifier</key>\n<string>${id}</string></dict></plist>`);
				await write('com.openai.chat');
				assert.isFalse(await Apps.isInstalled(getApp('codex')));
				await write('com.openai.codex');
				assert.isTrue(await Apps.isInstalled(getApp('codex')));
			}
		});
	});
});
