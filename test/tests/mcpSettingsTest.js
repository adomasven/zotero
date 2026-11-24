"use strict";

describe("MCP settings", function () {
	beforeEach(function () {
		Zotero.Prefs.set('mcp.enabled', true);
	});
	
	after(function () {
		Zotero.Prefs.clear('mcp.enabled');
	});
	
	describe("AI Apps pane", function () {
		let win, doc, pane, home, installed;
		
		beforeEach("open the pane with a temporary home directory and no installed apps", async function () {
			home = await getTempDirectory();
			sinon.stub(Zotero.MCP.Apps, 'getHomeDir').returns(home);
			installed = new Set();
			sinon.stub(Zotero.MCP.Apps, 'isInstalled').callsFake(async app => installed.has(app.id));
			Zotero.MCP.Permissions._reset();
			win = await loadPrefPane('mcp');
			doc = win.document;
			pane = win.Zotero_Preferences.MCP;
		});
		
		afterEach(function () {
			win.close();
			Zotero.MCP.Apps.getHomeDir.restore();
			Zotero.MCP.Apps.isInstalled.restore();
			Zotero.Prefs.set('mcp.enabled', true);
			Zotero.MCP.Permissions._reset();
		});
		
		async function waitForRows(expected) {
			let rows = () => pane._rows.map(row => [row.id, row.name]);
			for (let i = 0; i < 100 && JSON.stringify(rows()) != JSON.stringify(expected); i++) {
				await Zotero.Promise.delay(20);
			}
			assert.deepEqual(rows(), expected);
		}
		
		it("should hide the settings while MCP is off", async function () {
			assert.isFalse(doc.getElementById('mcp-settings').hidden);
			doc.getElementById('mcp-enabled').click();
			await Zotero.Promise.delay(50);
			assert.isFalse(Zotero.Prefs.get('mcp.enabled'));
			assert.isTrue(doc.getElementById('mcp-settings').hidden);
		});
		
		it("should list found apps and apps that have used Zotero in a table", async function () {
			installed.add('codex');
			await pane.updateApps();
			await waitForRows([['codex-mcp-client', 'ChatGPT and Codex']]);
			
			// A known app that connected some other way gets one row under its product name,
			// and an unknown app is listed by the name it gave
			Zotero.MCP.Permissions.recordClient('claude-code');
			Zotero.MCP.Permissions.recordClient('goose-desktop');
			Zotero.MCP.Permissions.recordClient('some-agent');
			await waitForRows([
				['codex-mcp-client', 'ChatGPT and Codex'],
				['claude-code', 'Claude Code'],
				['goose-desktop', 'Goose'],
				['some-agent', 'some-agent'],
			]);
			// Zotero can't connect Goose, so it has no status
			assert.equal(pane._rows[1].status, Zotero.MCP.AppConfig.STATUS_NOT_INSTALLED);
			assert.isNull(pane._rows[2].status);
			
			Zotero.MCP.Permissions.forgetClient('goose-desktop');
			
			Zotero.MCP.Permissions.forgetClient('some-agent');
			await waitForRows([
				['codex-mcp-client', 'ChatGPT and Codex'],
				['claude-code', 'Claude Code'],
			]);
		});
		
		it("should connect the selected app", async function () {
			if (!await IOUtils.exists(Zotero.MCP.getBinaryPath())) {
				this.skip();
			}
			installed.add('codex');
			await pane.updateApps();
			await waitForRows([['codex-mcp-client', 'ChatGPT and Codex']]);
			pane._tree.selection.select(0);
			let button = doc.getElementById('mcp-connect');
			assert.isFalse(button.disabled);
			await pane.toggleConnection();
			assert.equal(pane._rows[0].status, Zotero.MCP.AppConfig.STATUS_CONNECTED);
			assert.equal(button.dataset.l10nId, 'preferences-mcp-disconnect');
		});
	});
	
	describe("Permissions window", function () {
		beforeEach(function () {
			Zotero.MCP.Permissions._reset();
		});
		
		after(function () {
			Zotero.MCP.Permissions._reset();
		});
		
		it("should reflect grants live and fit the table to its libraries", async function () {
			let { Permissions } = Zotero.MCP;
			let libraryID = Zotero.Libraries.userLibraryID;
			let group = await createGroup();
			let prefWin = await loadPrefPane('mcp');
			let opened = waitForWindow('chrome://zotero/content/mcpPermissions.xhtml');
			// Modal, so it returns only once the window closes
			setTimeout(() => Zotero.MCP.openPermissionsWindow('claude-code', prefWin));
			let permWin = await opened;
			while (!permWin.Zotero_MCP_Permissions?._tree || !permWin.Zotero_MCP_Permissions._rows.length) {
				await Zotero.Promise.delay(20);
			}
			
			// Every library shows, without scrolling or empty space
			let perms = permWin.Zotero_MCP_Permissions;
			assert.isAtLeast(perms._rows.length, 2);
			let body = permWin.document.querySelector('#mcp-permissions-libraries-table .virtualized-table-body');
			assert.equal(body.scrollHeight, body.clientHeight);
			assert.isBelow(body.clientHeight, (perms._rows.length + 1) * perms._tree._rowHeight);
			
			let index = perms._rows.findIndex(row => row.libraryID == libraryID);
			assert.isFalse(perms._rows[index].edit);
			// A consent dialog grants while the window is open
			Permissions.grant('claude-code', Permissions.EDIT_LIBRARY, libraryID);
			assert.isTrue(perms._rows[index].edit);
			// Toggling revokes, and allowing moving to the trash lasts an hour
			perms.toggle(index, Permissions.EDIT_LIBRARY);
			assert.isFalse(Permissions.isGranted('claude-code', Permissions.EDIT_LIBRARY, libraryID));
			perms.toggle(index, Permissions.DELETE);
			let until = Date.parse(Permissions.getGrants('claude-code')[0].until);
			assert.approximately(until - Date.now(), Permissions.TEMPORARY_GRANT, 5000);
			permWin.close();
			prefWin.close();
			await group.eraseTx();
		});
	});
});
