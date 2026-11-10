"use strict";

describe("MCP tools", function () {
	let { Permissions } = Zotero.MCP;
	
	beforeEach(function () {
		Zotero.Prefs.set('mcp.enabled', true);
	});
	
	afterEach(function () {
		sinon.restore();
		Permissions._reset();
	});
	
	after(function () {
		Zotero.Prefs.clear('mcp.enabled');
	});
	
	async function call(name, args) {
		let { result } = await callMCPTool(name, args);
		assert.notOk(result.isError, result.content[0].text);
		return result.structuredContent;
	}
	
	async function callForError(name, args) {
		let { result } = await callMCPTool(name, args);
		assert.isTrue(result.isError);
		return result.content[0].text;
	}
	
	it("should have a handler for every tool", async function () {
		for (let tool of await Zotero.MCP.getTools()) {
			// Arguments no tool takes, so nothing runs
			let result = await Zotero.MCP.callTool(tool.name, { notAnArgument: true }, { clientID: 'test' });
			assert.isObject(result, tool.name);
		}
	});
	
	async function createArticle({ title = Zotero.Utilities.randomString(), lastName, date, ...params } = {}) {
		return createDataObject('item', {
			itemType: 'journalArticle',
			title,
			creators: lastName ? [{ firstName: 'Ann', lastName, creatorType: 'author' }] : [],
			...params,
		}).then(async (item) => {
			if (date) {
				item.setField('date', date);
				await item.saveTx();
			}
			return item;
		});
	}
	
	describe("zotero_search", function () {
		it("should filter by creator with by:, and match titles only as free text", async function () {
			let name = Zotero.Utilities.randomString();
			let byName = await createArticle({ lastName: name });
			let aboutName = await createArticle({ title: `On ${name}` });
			
			let { items } = await call('zotero_search', { query: `by:${name}` });
			assert.deepEqual(items.map(item => item.key), [byName.key]);
			assert.equal(items[0].creators, name);
			assert.equal(items[0].link, `zotero://select/library/items/${byName.key}`);
			
			({ items } = await call('zotero_search', { query: name, mode: 'titleCreatorYear' }));
			assert.sameMembers(items.map(item => item.key), [byName.key, aboutName.key]);
		});
		
		it("should return an item once for matches in its notes, and the notes for type:note", async function () {
			let word = Zotero.Utilities.randomString();
			let item = await createArticle();
			let notes = [];
			for (let i = 0; i < 2; i++) {
				notes.push(await createDataObject('item', { itemType: 'note', parentID: item.id, note: `<p>${word}</p>` }));
			}
			
			let { items } = await call('zotero_search', { query: word, mode: 'fields' });
			assert.deepEqual(items.map(item => item.key), [item.key]);
			
			({ items } = await call('zotero_search', { query: `type:note ${word}` }));
			assert.sameMembers(items.map(item => item.key), notes.map(note => note.key));
			assert.isTrue(items.every(note => note.parentKey == item.key));
		});
		
		it("should list a collection's items, sorted and in pages", async function () {
			let collection = await createDataObject('collection');
			let prefix = Zotero.Utilities.randomString();
			let keys = [];
			for (let title of ['b', 'c', 'a']) {
				keys.push((await createArticle({ title: `${prefix} ${title}`, collections: [collection.id] })).key);
			}
			// Not in the collection
			await createArticle({ title: `${prefix} d` });
			let [b, c, a] = keys;
			
			let page = await call('zotero_search', { collectionKey: collection.key, sort: 'title', limit: 2 });
			assert.equal(page.total, 3);
			assert.deepEqual(page.items.map(item => item.key), [a, b]);
			assert.equal(page.nextOffset, 2);
			
			page = await call('zotero_search', { collectionKey: collection.key, sort: 'title', direction: 'desc', limit: 2 });
			assert.deepEqual(page.items.map(item => item.key), [c, b]);
			page = await call('zotero_search', { collectionKey: collection.key, sort: 'title', direction: 'desc', limit: 2, offset: 2 });
			assert.deepEqual(page.items.map(item => item.key), [a]);
			assert.notProperty(page, 'nextOffset');
			
			assert.equal((await call('zotero_search', { query: prefix, collectionKey: collection.key })).total, 3);
			assert.equal((await call('zotero_search', { query: prefix })).total, 4);
		});
		
		it("should search the given library, and not the trash", async function () {
			let group = await getGroup();
			let title = Zotero.Utilities.randomString();
			let inGroup = await createArticle({ title, libraryID: group.libraryID });
			await createArticle({ title, deleted: true });
			
			assert.equal((await call('zotero_search', { query: title })).total, 0);
			let { items } = await call('zotero_search', { query: title, libraryID: group.libraryID });
			assert.deepEqual(items.map(item => item.key), [inGroup.key]);
			assert.equal(items[0].link, `zotero://select/groups/${group.id}/items/${inGroup.key}`);
		});
		
		it("should reject a collection that doesn't exist", async function () {
			assert.match(await callForError('zotero_search', { collectionKey: 'AAAAAAAA' }), /No collection AAAAAAAA/);
		});
	});
	
	describe("zotero_get_items", function () {
		it("should return the items' data with their attachments and notes, and the keys it didn't find", async function () {
			let item = await createArticle({ lastName: 'Smith' });
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let note = await createDataObject('item', { itemType: 'note', parentID: item.id, note: '<p>My note</p>' });
			
			let { items, missing } = await call('zotero_get_items', { keys: [item.key, 'AAAAAAAA'] });
			assert.deepEqual(missing, ['AAAAAAAA']);
			assert.lengthOf(items, 1);
			assert.equal(items[0].title, item.getField('title'));
			assert.equal(items[0].creators[0].lastName, 'Smith');
			assert.deepEqual(items[0].attachments, [{
				key: attachment.key,
				title: 'test',
				contentType: 'application/pdf',
				linkMode: 'imported_file',
				fileExists: true,
				annotationCount: 0,
			}]);
			assert.deepEqual(items[0].notes, [{ key: note.key, title: 'My note' }]);
		});
	});
	
	describe("zotero_list_collections", function () {
		it("should list a collection's subcollections at any depth, with item counts", async function () {
			let parent = await createDataObject('collection');
			let child = await createDataObject('collection', { parentID: parent.id });
			let grandchild = await createDataObject('collection', { parentID: child.id });
			await createDataObject('collection');
			await createArticle({ collections: [grandchild.id] });
			
			let { collections } = await call('zotero_list_collections', { parentKey: parent.key });
			assert.sameDeepMembers(collections, [
				{ key: child.key, name: child.name, parentKey: parent.key, itemCount: 0 },
				{ key: grandchild.key, name: grandchild.name, parentKey: child.key, itemCount: 1 },
			]);
		});
	});
	
	describe("zotero_list_tags", function () {
		let colored;
		
		afterEach(async function () {
			await Zotero.Tags.setColor(Zotero.Libraries.userLibraryID, colored, false);
		});
		
		it("should list tags with counts, without trashed items, colored tags first", async function () {
			let prefix = Zotero.Utilities.randomString();
			let [one, two] = [`${prefix} one`, `${prefix} two`];
			colored = `${prefix} colored`;
			await createArticle({ tags: [{ tag: one }, { tag: two }] });
			await createArticle({ tags: [{ tag: two }] });
			await createArticle({ tags: [{ tag: one }], deleted: true });
			await Zotero.Tags.setColor(Zotero.Libraries.userLibraryID, colored, '#ff6666', 0);
			
			let { tags, total } = await call('zotero_list_tags', { query: prefix.toLowerCase() });
			assert.equal(total, 3);
			assert.deepEqual(tags, [
				{ name: colored, count: 0, color: '#ff6666' },
				{ name: two, count: 2 },
				{ name: one, count: 1 },
			]);
		});
	});
	
	describe("zotero_generate_citation", function () {
		const STYLE_ID = 'http://www.zotero.org/styles/zotero-mcp-test';
		let item;
		
		before(async function () {
			item = await createArticle({ title: 'A study of things', lastName: 'Quuxly', date: '2020' });
		});
		
		after(async function () {
			let style = Zotero.Styles.get(STYLE_ID);
			if (style) {
				await style.remove();
			}
		});
		
		it("should format a citation with a page locator", async function () {
			let result = await call('zotero_generate_citation', {
				items: [{ key: item.key, locator: '23' }],
				format: 'citation',
				style: 'apa',
			});
			assert.equal(result.output, '(Quuxly, 2020, p. 23)');
			assert.equal(result.style, 'http://www.zotero.org/styles/apa');
			
			result = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'citation', style: 'apa' });
			assert.equal(result.output, '(Quuxly, 2020)');
		});
		
		it("should format a bibliography as text or HTML", async function () {
			let { output } = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'bibliography', style: 'apa' });
			assert.match(output, /^Quuxly, A\. \(2020\)\. A study of things\.$/);
			({ output } = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'bibliography', style: 'apa', html: true }));
			assert.include(output, 'csl-entry');
		});
		
		it("should export BibTeX", async function () {
			let { output } = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'bibtex' });
			assert.match(output, /^@article\{/);
			assert.include(output, 'title = {A study of things}');
		});
		
		it("should not cite notes", async function () {
			let note = await createDataObject('item', { itemType: 'note' });
			let error = await callForError('zotero_generate_citation', { items: [{ key: note.key }], format: 'citation' });
			assert.match(error, /can't be cited/);
		});
		
		describe("style that isn't installed", function () {
			let requests;
			
			beforeEach(function () {
				let xml = Zotero.Styles.get('http://www.zotero.org/styles/apa').getXML()
					.replace(/<id>[^<]*<\/id>/, `<id>${STYLE_ID}</id>`)
					.replace(/<title>[^<]*<\/title>/, '<title>Zotero MCP Test</title>')
					.replace(/<link [^>]*rel="self"[^>]*\/>/, `<link href="${STYLE_ID}" rel="self"/>`);
				requests = [];
				let request = Zotero.HTTP.request;
				sinon.stub(Zotero.HTTP, 'request').callsFake(async (method, url, options) => {
					if (!url.startsWith('https://www.zotero.org/styles/')) {
						return request.call(Zotero.HTTP, method, url, options);
					}
					requests.push(url);
					if (url.endsWith('/zotero-mcp-test')) {
						return { status: 200, response: xml };
					}
					throw new Zotero.HTTP.UnexpectedStatusException({ status: 404 }, url, 'Not found');
				});
			});
			
			it("should not ask about a style the repository doesn't have", async function () {
				let ask = sinon.stub(Permissions, '_ask');
				let error = await callForError('zotero_generate_citation', { items: [{ key: item.key }], format: 'citation', style: 'no-such-style' });
				assert.match(error, /No style "no-such-style"/);
				assert.isFalse(ask.called);
			});
			
			it("should only install it if the user allows it", async function () {
				let ask = sinon.stub(Permissions, '_ask').resolves('deny');
				let error = await callForError('zotero_generate_citation', { items: [{ key: item.key }], format: 'citation', style: 'zotero-mcp-test' });
				assert.match(error, /denied/);
				assert.isTrue(ask.calledWith('test-client', Permissions.INSTALL_STYLES));
				assert.isFalse(Zotero.Styles.get(STYLE_ID));
				
				ask.resolves('allow');
				let result = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'citation', style: 'zotero-mcp-test' });
				assert.equal(result.style, STYLE_ID);
				assert.equal(result.output, '(Quuxly, 2020)');
				assert.deepEqual(requests, [
					'https://www.zotero.org/styles/zotero-mcp-test',
					'https://www.zotero.org/styles/zotero-mcp-test',
				]);
			});
			
			it("should only install styles from the repository", async function () {
				let error = await callForError('zotero_generate_citation', {
					items: [{ key: item.key }],
					format: 'citation',
					style: 'https://example.com/style.csl',
				});
				assert.match(error, /only be installed from the Zotero Style Repository/);
				assert.lengthOf(requests, 0);
			});
		});
	});
});
