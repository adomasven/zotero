"use strict";

describe("Zotero.MCP.Permissions", function () {
	let { Permissions } = Zotero.MCP;
	let item;
	
	beforeEach(async function () {
		Zotero.Prefs.set('mcp.enabled', true);
		Permissions._reset();
		item = await createDataObject('item');
	});
	
	afterEach(function () {
		sinon.restore();
	});
	
	after(function () {
		Zotero.Prefs.clear('mcp.enabled');
		Permissions._reset();
	});
	
	function addTag(tag, clientInfo) {
		return callMCPTool('zotero_update_items', { changes: [{ key: item.key, addTags: [tag] }] }, clientInfo);
	}
	
	async function getDialog() {
		let win;
		let find = () => [...Services.wm.getEnumerator(null)]
			.find(w => w.location.href == 'chrome://global/content/commonDialog.xhtml');
		while (!(win = find()) || win.document.readyState != 'complete') {
			await Zotero.Promise.delay(20);
		}
		return win;
	}
	
	async function waitForClose(win) {
		for (let i = 0; i < 100 && !win.closed; i++) {
			await Zotero.Promise.delay(20);
		}
		assert.isTrue(win.closed);
	}
	
	it("should let apps read without asking", async function () {
		let ask = sinon.stub(Permissions, '_ask');
		let { result } = await callMCPTool('zotero_search', {});
		assert.notOk(result.isError);
		assert.isFalse(ask.called);
	});
	
	it("should ask before an edit and allow it once", async function () {
		let ask = sinon.stub(Permissions, '_ask').resolves('allow');
		let { result } = await addTag('a');
		assert.notOk(result.isError, result.content[0].text);
		assert.isTrue(item.hasTag('a'));
		assert.isTrue(ask.calledOnceWith('test-client', Permissions.EDIT_LIBRARY, item.libraryID));
		
		// Allow doesn't remember
		await addTag('b');
		assert.equal(ask.callCount, 2);
	});
	
	it("should remember Always Allow per app and library", async function () {
		let ask = sinon.stub(Permissions, '_ask').resolves('extra');
		await addTag('a');
		await addTag('b');
		assert.equal(ask.callCount, 1);
		assert.isTrue(item.hasTag('b'));
		assert.isTrue(Permissions.isGranted('test-client', Permissions.EDIT_LIBRARY, item.libraryID));
		
		// Another app is asked separately
		await addTag('c', { name: 'other-app', version: '1' });
		assert.equal(ask.callCount, 2);
		// So is another library
		let group = await createGroup();
		assert.isFalse(Permissions.isGranted('test-client', Permissions.EDIT_LIBRARY, group.libraryID));
		
		let { result } = await callMCPTool('zotero_status', {});
		let { permissions } = result.structuredContent;
		assert.deepEqual(permissions, [
			{ permission: Permissions.EDIT_LIBRARY, libraryID: item.libraryID, until: null }
		]);
	});
	
	it("should grant delete for an hour instead of always", async function () {
		sinon.stub(Permissions, '_ask').resolves('extra');
		await Permissions.require('test-client', Permissions.DELETE, item.libraryID, {});
		let [grant] = Permissions.getGrants('test-client');
		assert.equal(grant.permission, Permissions.DELETE);
		let expiresIn = new Date(grant.until) - Date.now();
		assert.approximately(expiresIn, 60 * 60 * 1000, 60 * 1000);
		
		// An expired grant asks again
		Permissions.grant('test-client', Permissions.DELETE, item.libraryID, Date.now() - 1);
		assert.isFalse(Permissions.isGranted('test-client', Permissions.DELETE, item.libraryID));
	});
	
	it("should check the library before asking", async function () {
		let ask = sinon.stub(Permissions, '_ask');
		let { result } = await callMCPTool(
			'zotero_update_items', { changes: [{ key: item.key, addTags: ['a'] }], libraryID: 99999 }
		);
		assert.isTrue(result.isError);
		assert.match(result.content[0].text, /No library/);
		assert.isFalse(ask.called);
	});
	
	it("should tell the model the user denied an edit", async function () {
		sinon.stub(Permissions, '_ask').resolves('deny');
		let { result } = await addTag('a');
		assert.isTrue(result.isError);
		assert.match(result.content[0].text, /denied/);
		assert.isFalse(item.hasTag('a'));
	});
	
	it("should tell the model the permission prompt timed out", async function () {
		sinon.stub(Permissions, '_ask').resolves(null);
		let { result } = await addTag('a');
		assert.isTrue(result.isError);
		assert.match(result.content[0].text, /didn't answer/);
		assert.isFalse(item.hasTag('a'));
	});
	
	it("should share grants among the names an app gives", async function () {
		let ask = sinon.stub(Permissions, '_ask').resolves('extra');
		await addTag('a', { name: 'cursor-vscode', version: '1' });
		assert.isTrue(Permissions.isGranted('Cursor', Permissions.EDIT_LIBRARY, item.libraryID));
		await addTag('b', { name: 'Cursor', version: '1' });
		assert.equal(ask.callCount, 1);
		Permissions.revoke('Cursor', Permissions.EDIT_LIBRARY, item.libraryID);
		assert.isFalse(Permissions.isGranted('cursor-vscode', Permissions.EDIT_LIBRARY, item.libraryID));
	});
	
	it("should cancel calls waiting for permission when MCP is turned off", async function () {
		let call = addTag('a');
		let win = await getDialog();
		Zotero.Prefs.set('mcp.enabled', false);
		await waitForClose(win);
		let { result } = await call;
		assert.isTrue(result.isError);
		assert.match(result.content[0].text, /turned off/);
		assert.isFalse(item.hasTag('a'));
		assert.isFalse(Permissions.isGranted('test-client', Permissions.EDIT_LIBRARY, item.libraryID));
	});
	
	it("should ask once for parallel calls needing the same grant", async function () {
		let { promise, resolve } = Promise.withResolvers();
		let ask = sinon.stub(Permissions, '_ask').returns(promise);
		let calls = [addTag('a'), addTag('b')];
		await Zotero.Promise.delay(100);
		resolve('allow');
		let results = await Promise.all(calls);
		assert.equal(ask.callCount, 1);
		assert.isTrue(results.every(({ result }) => !result.isError));
		assert.isTrue(item.hasTag('a') && item.hasTag('b'));
	});
	
	it("should be declared by tools only as known permissions, with a libraryID argument for library ones", async function () {
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
	
	describe("dialog", function () {
		let options;
		
		beforeEach(function () {
			options = { deadline: Date.now() + 60 * 1000 };
		});
		
		it("should name the app and action, and offer Always Allow for edits", async function () {
			let answer = Permissions._ask('claude-code', Permissions.EDIT_LIBRARY, item.libraryID, options);
			let win = await getDialog();
			let dialog = win.document.getElementById('commonDialog');
			let text = win.document.getElementById('infoBody').textContent;
			assert.include(text, '“Claude Code”');
			assert.equal(win.document.getElementById('infoIcon').getAttribute('src'), Zotero.MCP.Apps.getForClient('claude-code').icon);
			assert.include(text, Zotero.Libraries.get(item.libraryID).name);
			assert.equal(dialog.getButton('extra1').label, Zotero.ftl.formatValueSync('general-always-allow'));
			// Enter allows, Escape denies
			assert.equal(dialog.defaultButton, 'accept');
			dialog.getButton('extra1').click();
			assert.equal(await answer, 'extra');
		});
		
		it("should deny on Escape", async function () {
			let answer = Permissions._ask('test-client', Permissions.EDIT_LIBRARY, item.libraryID, options);
			let win = await getDialog();
			win.document.getElementById('commonDialog')
				.dispatchEvent(new win.KeyboardEvent('keypress', { key: 'Escape', keyCode: 27, bubbles: true }));
			assert.equal(await answer, 'deny');
		});
		
		it("should offer Allow for 1 Hour for delete, and count closing as Deny", async function () {
			let answer = Permissions._ask('test-client', Permissions.DELETE, item.libraryID, options);
			let win = await getDialog();
			let dialog = win.document.getElementById('commonDialog');
			assert.equal(dialog.getButton('extra1').label, Zotero.ftl.formatValueSync('mcp-consent-allow-hour'));
			win.close();
			assert.equal(await answer, 'deny');
		});
		
		it("should close an unanswered dialog at the call's deadline, as no answer", async function () {
			let answer = Permissions._ask('test-client', Permissions.EDIT_SETTINGS, null, { deadline: Date.now() + 300 });
			let win = await getDialog();
			assert.isNull(await answer);
			await Zotero.Promise.delay(100);
			assert.isTrue(win.closed);
		});
	});
});
