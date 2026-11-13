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
	
	/**
	 * Give an attachment known full text, as if it had been indexed, with PDF pages
	 * separated as the PDF worker separates them
	 */
	async function setText(attachment, pages, { indexedPages = pages.length, totalPages = indexedPages } = {}) {
		await Zotero.FullText.setItemContent(attachment.libraryID, attachment.key, {
			content: pages.join('\n\n\f').trim(),
			indexedPages,
			totalPages,
		}, 1);
		assert.isTrue(await Zotero.FullText.indexSyncedContent(attachment.id));
	}
	
	/**
	 * Make tool calls with a shorter time budget
	 */
	async function withBudget(budget, fn) {
		let saved = Zotero.MCP.CALL_BUDGET;
		Zotero.MCP.CALL_BUDGET = budget;
		try {
			return await fn();
		}
		finally {
			Zotero.MCP.CALL_BUDGET = saved;
		}
	}
	
	function stubStructure(catalog) {
		return sinon.stub(Zotero.SDT, 'getReader').resolves({ getCatalog: async () => catalog });
	}
	
	let randomWord = () => Zotero.Utilities.randomString(12, 'abcdefghijklmnopqrstuvwxyz');
	
	describe("zotero_search_fulltext", function () {
		it("should return passages by page, with every term's passages first and the original text", async function () {
			let word = randomWord();
			let item = await createArticle();
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			await setText(attachment, [
				`Introduction about ${word} cycles.`,
				`Here Sôil–organic matter and ${word} interact.`,
				`Only soil here, and organic elsewhere, with ${word}.`,
			]);
			// Has the word but not the phrase
			let other = await importFileAttachment('test.pdf');
			await setText(other, [`Just ${word}.`]);
			stubStructure({ pages: [{ label: 'i' }, { label: '1' }, { label: '2' }] });
			
			let { total, results } = await call('zotero_search_fulltext', { query: `${word} "soil organic"` });
			assert.equal(total, 1);
			assert.equal(results[0].key, attachment.key);
			assert.equal(results[0].parentKey, item.key);
			assert.equal(results[0].title, item.getField('title'));
			assert.equal(results[0].matchCount, 4);
			assert.deepEqual(results[0].passages, [
				{
					page: 2,
					pageLabel: '1',
					text: `Here Sôil–organic matter and ${word} interact.`,
					link: `zotero://open/library/items/${attachment.key}?page=2`,
				},
				{
					page: 1,
					pageLabel: 'i',
					text: `Introduction about ${word} cycles.`,
					link: `zotero://open/library/items/${attachment.key}?page=1`,
				},
				{
					page: 3,
					pageLabel: '2',
					text: `Only soil here, and organic elsewhere, with ${word}.`,
					link: `zotero://open/library/items/${attachment.key}?page=3`,
				},
			]);
		});
		
		it("should cut long text into passages between words", async function () {
			let word = randomWord();
			let attachment = await importFileAttachment('test.pdf');
			// ß is ss when normalized for search, so matches are found at other offsets than
			// they're cut at
			let filler = 'maße ipsum '.repeat(70);
			await setText(attachment, [`${filler}${word} ${filler}`]);
			
			let { results } = await call('zotero_search_fulltext', { query: word });
			let [{ text }] = results[0].passages;
			assert.match(text, new RegExp(`^…(maße|ipsum) .* ${word} .* (maße|ipsum)…$`));
			// About 200 characters on each side
			assert.closeTo(text.indexOf(word), 195, 10);
			assert.closeTo(text.length - text.indexOf(word) - word.length, 195, 10);
		});
		
		it("should search only the given items' files", async function () {
			let word = randomWord();
			let items = [];
			for (let i = 0; i < 2; i++) {
				let item = await createArticle();
				await setText(await importFileAttachment('test.pdf', { parentID: item.id }), [word]);
				items.push(item);
			}
			
			assert.equal((await call('zotero_search_fulltext', { query: word })).total, 2);
			let { results } = await call('zotero_search_fulltext', { query: word, keys: [items[1].key] });
			assert.deepEqual(results.map(result => result.parentKey), [items[1].key]);
		});
	});
	
	describe("zotero_search_fulltext when indexing is slow", function () {
		it("should list files whose text isn't ready by the deadline", async function () {
			let attachment = await importFileAttachment('test.pdf');
			await setText(attachment, ['Some text']);
			// In the index, but its text has to be extracted again
			sinon.stub(Zotero.FullText, 'findItemsWithContent').resolves([attachment.id]);
			await IOUtils.remove(Zotero.FullText.getItemCacheFile(attachment).path);
			let indexing = Zotero.Promise.defer();
			sinon.stub(Zotero.FullText, 'indexItems').returns(indexing.promise);
			
			let result = await withBudget(300, () => call('zotero_search_fulltext', { query: 'text' }));
			assert.deepEqual(result.results.map(file => [file.key, file.textPending]), [[attachment.key, true]]);
			assert.match(result.notice, /still getting the text of the files with textPending/);
			indexing.resolve();
		});
	});
	
	describe("zotero_read_text", function () {
		beforeEach(function () {
			// No structured document text, as for a password-protected PDF
			sinon.stub(Zotero.SDT, 'getPack').resolves({ ok: false, reason: 'unavailable' });
		});
		
		afterEach(function () {
			Zotero.MCP.Tools._structureWait = 15 * 1000;
		});
		
		it("should read a PDF by page, up to about maxChars, with labels and the outline", async function () {
			let item = await createArticle();
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let pages = ['a', 'b', 'c'].map(letter => `${letter} `.repeat(300).trim());
			await setText(attachment, pages);
			stubStructure({
				pages: [{ label: 'i' }, { label: '1' }, { label: '2' }],
				outline: [{
					title: 'Chapter',
					target: { position: { pageIndex: 1 } },
					children: [{ title: 'Section', target: { position: { pageIndex: 2 } } }],
				}],
			});
			
			// The parent's key reads its PDF
			let result = await call('zotero_read_text', { key: item.key, maxChars: 1000 });
			assert.equal(result.key, attachment.key);
			assert.equal(result.totalPages, 3);
			assert.deepEqual(result.pages, [
				{ page: 1, label: 'i', text: pages[0] },
				{ page: 2, label: '1', text: pages[1] },
			]);
			assert.equal(result.nextPage, 3);
			assert.deepEqual(result.outline, [
				{ title: 'Chapter', page: 2, children: [{ title: 'Section', page: 3 }] },
			]);
			assert.notProperty(result, 'notice');
			
			result = await call('zotero_read_text', { key: attachment.key, startPage: 3 });
			assert.deepEqual(result.pages, [{ page: 3, label: '2', text: pages[2] }]);
			assert.notProperty(result, 'nextPage');
			assert.notProperty(result, 'outline');
		});
		
		it("should wait for page labels only until the deadline, and have them later", async function () {
			let attachment = await importFileAttachment('test.pdf');
			await setText(attachment, ['One', 'Two']);
			Zotero.MCP.Tools._structureWait = 200;
			let getReader = sinon.stub(Zotero.SDT, 'getReader');
			let catalog = { pages: [{ label: 'i' }, { label: 'ii' }] };
			let generated = Zotero.Promise.delay(1000).then(() => ({ getCatalog: async () => catalog }));
			getReader.returns(generated);
			
			let result = await call('zotero_read_text', { key: attachment.key, startPage: 2 });
			assert.deepEqual(result.pages, [{ page: 2, text: 'Two' }]);
			assert.match(result.notice, /Page labels .* aren't available yet/);
			assert.isTrue(getReader.calledWith(attachment.id, sinon.match({ isPriority: true })));
			
			// Generation went on, so a later call has the labels
			await generated;
			result = await call('zotero_read_text', { key: attachment.key, startPage: 2 });
			assert.deepEqual(result.pages, [{ page: 2, label: 'ii', text: 'Two' }]);
			assert.notProperty(result, 'notice');
		});
		
		it("should extract pages past the ones Zotero indexed", async function () {
			this.timeout(30000);
			Zotero.Prefs.set('fulltext.pdfMaxPages', 1);
			try {
				let attachment = await importFileAttachment('wonderland_short.pdf');
				assert.equal((await Zotero.FullText.getPages(attachment.id)).indexedPages, 1);
				let expected = (await Zotero.PDFWorker.getFullText(attachment.id, [1, 2])).text
					.split('\f').map(text => text.trim());
				
				let result = await call('zotero_read_text', { key: attachment.key, startPage: 2, endPage: 3 });
				assert.equal(result.totalPages, 29);
				assert.deepEqual(result.pages, [{ page: 2, text: expected[0] }, { page: 3, text: expected[1] }]);
				assert.isNotEmpty(expected[0]);
				assert.notEqual(expected[0], expected[1]);
			}
			finally {
				Zotero.Prefs.clear('fulltext.pdfMaxPages');
			}
		});
		
		it("should return the pages it has by the deadline, and say more are coming", async function () {
			let attachment = await importFileAttachment('test.pdf');
			await setText(attachment, ['One', 'Two'], { totalPages: 4 });
			let extracted = Zotero.Promise.defer();
			sinon.stub(Zotero.PDFWorker, 'getFullText').returns(extracted.promise);
			
			let result = await withBudget(300, () => call('zotero_read_text', { key: attachment.key }));
			assert.deepEqual(result.pages, [{ page: 1, text: 'One' }, { page: 2, text: 'Two' }]);
			assert.equal(result.nextPage, 3);
			assert.match(result.notice, /still getting the text/);
			
			extracted.resolve({ text: 'Three\fFour', totalPages: 4 });
			result = await call('zotero_read_text', { key: attachment.key, startPage: 3 });
			assert.deepEqual(result.pages, [{ page: 3, text: 'Three' }, { page: 4, text: 'Four' }]);
			assert.notProperty(result, 'notice');
		});
		
		it("should say when a file's text isn't ready by the deadline", async function () {
			let attachment = await importFileAttachment('stub.epub');
			await IOUtils.remove(Zotero.FullText.getItemCacheFile(attachment).path, { ignoreAbsent: true });
			let indexing = Zotero.Promise.defer();
			sinon.stub(Zotero.FullText, 'indexItems').returns(indexing.promise);
			
			let result = await withBudget(300, () => call('zotero_read_text', { key: attachment.key }));
			assert.notProperty(result, 'text');
			assert.match(result.notice, /still getting the text/);
			indexing.resolve();
		});
		
		it("should read other files in chunks that end between words", async function () {
			// Words and their spaces are 7 characters, so the character after each 1000 is a space
			let words = [];
			for (let i = 0; i < 600; i++) {
				words.push(`w${String(i).padStart(5, '0')}`);
			}
			let content = words.join(' ');
			let path = PathUtils.join(await getTempDirectory(), 'words.txt');
			await Zotero.File.putContentsAsync(path, content);
			let attachment = await Zotero.Attachments.importFromFile({ file: path });
			
			let chunks = [];
			let offset = 0;
			while (offset !== undefined) {
				let result = await call('zotero_read_text', { key: attachment.key, offset, maxChars: 1000 });
				assert.equal(result.totalChars, content.length);
				assert.isAtMost(result.text.length, 1000);
				chunks.push(result.text);
				offset = result.nextOffset;
			}
			assert.isAbove(chunks.length, 3);
			assert.equal(chunks.join(''), content);
			assert.isTrue(chunks.slice(0, -1).every(chunk => chunk.endsWith(' ')));
		});
		
		it("should reject items without a readable file", async function () {
			let note = await createDataObject('item', { itemType: 'note' });
			assert.match(await callForError('zotero_read_text', { key: note.key }), /isn't a file Zotero can get text from/);
			let item = await createArticle();
			assert.match(await callForError('zotero_read_text', { key: item.key }), /has no PDF/);
		});
	});
	
	describe("zotero_get_notes", function () {
		it("should return an item's notes as Markdown and its annotations in file order", async function () {
			let item = await createArticle();
			let note = await createDataObject('item', {
				itemType: 'note',
				parentID: item.id,
				note: '<h1>Findings</h1><p>Some <strong>bold</strong> text</p>',
			});
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let annotations = [];
			for (let [pageIndex, position] of [[4, '000500'], [0, '000100'], [4, '000200']]) {
				let annotation = await createAnnotation('highlight', attachment);
				annotation.annotationSortIndex = `${String(pageIndex).padStart(5, '0')}|${position}|00000`;
				annotation.annotationPosition = JSON.stringify({ pageIndex, rects: [[0, 0, 1, 1]] });
				annotation.addTag('important');
				await annotation.saveTx();
				annotations.push(annotation);
			}
			let [last, first, middle] = annotations;
			
			let result = await call('zotero_get_notes', { keys: [item.key, 'AAAAAAAA'] });
			assert.deepEqual(result.missing, ['AAAAAAAA']);
			assert.lengthOf(result.notes, 1);
			assert.equal(result.notes[0].key, note.key);
			assert.equal(result.notes[0].title, 'Findings');
			assert.match(result.notes[0].content, /^# Findings\n\nSome \*\*bold\*\* text$/);
			assert.deepEqual(result.annotations.map(annotation => annotation.key), [first.key, middle.key, last.key]);
			assert.deepEqual(result.annotations[2], {
				key: last.key,
				attachmentKey: attachment.key,
				type: 'highlight',
				text: last.annotationText,
				comment: last.annotationComment,
				color: '#ffd400',
				page: 5,
				pageLabel: last.annotationPageLabel,
				tags: ['important'],
				link: `zotero://open/library/items/${attachment.key}?annotation=${last.key}`,
			});
			
			result = await call('zotero_get_notes', { keys: [note.key], format: 'html' });
			assert.include(result.notes[0].content, '<strong>bold</strong>');
			assert.lengthOf(result.annotations, 0);
		});
	});
	
	describe("zotero_get_context", function () {
		let win;
		
		before(async function () {
			win = await loadZoteroPane();
		});
		
		after(function () {
			win.Zotero_Tabs.closeAll();
			win.close();
		});
		
		it("should return the selected collection and items", async function () {
			let collection = await createDataObject('collection');
			let items = [];
			for (let i = 0; i < 3; i++) {
				items.push(await createArticle({ collections: [collection.id] }));
			}
			await win.ZoteroPane.collectionsView.selectCollection(collection.id);
			await win.ZoteroPane.selectItems([items[0].id, items[2].id]);
			
			let context = await call('zotero_get_context', {});
			assert.equal(context.tab, 'library');
			assert.equal(context.libraryID, Zotero.Libraries.userLibraryID);
			assert.deepEqual(context.collections, [{ key: collection.key, name: collection.name }]);
			assert.equal(context.selectedItemCount, 2);
			assert.sameMembers(context.selectedItems.map(item => item.key), [items[0].key, items[2].key]);
			assert.notProperty(context, 'reader');
		});
		
		it("should return the open file, its page, and the selected text and annotations", async function () {
			let item = await createArticle();
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let annotation = await createAnnotation('highlight', attachment);
			let reader = await Zotero.Reader.open(attachment.id);
			await reader._initPromise;
			let internalReader = reader._internalReader;
			await waitForCallback(() => internalReader._state.primaryViewStats.pageLabel !== undefined);
			let readerWindow = reader._iframeWindow;
			internalReader.setSelectedAnnotations(Cu.cloneInto([annotation.key], readerWindow));
			// As the reader's state has it while text is selected (see getReaderState() in tools.js)
			internalReader._state.primaryViewSelectionPopup = Cu.cloneInto({
				annotation: {
					text: 'Selected words',
					pageLabel: '1',
					position: { pageIndex: 0, rects: [[1, 1, 2, 2]] },
				},
			}, readerWindow);
			
			let context = await call('zotero_get_context', {});
			assert.equal(context.tab, 'reader');
			let { selectedAnnotations, ...rest } = context.reader;
			assert.deepEqual(rest, {
				libraryID: attachment.libraryID,
				key: attachment.key,
				parentKey: item.key,
				title: item.getField('title'),
				contentType: 'application/pdf',
				type: 'pdf',
				page: 1,
				pageLabel: '1',
				link: `zotero://open/library/items/${attachment.key}?page=1`,
				selection: { text: 'Selected words', page: 1, pageLabel: '1' },
			});
			assert.deepEqual(selectedAnnotations.map(annotation => annotation.key), [annotation.key]);
			
			// "-" is the reader's label for a page whose label it couldn't determine
			internalReader._state.primaryViewSelectionPopup.annotation.pageLabel = '-';
			context = await call('zotero_get_context', {});
			assert.deepEqual(context.reader.selection, { text: 'Selected words', page: 1 });
			internalReader._state.primaryViewSelectionPopup = null;
		});
		
		it("should say when the main window isn't open", async function () {
			sinon.stub(Zotero, 'getMainWindow').returns(null);
			assert.deepEqual(await call('zotero_get_context', {}), { window: false });
		});
	});
	
	describe("zotero_generate_citation", function () {
		const STYLE_ID = 'http://www.zotero.org/styles/zotero-mcp-test';
		let item;
		
		before(async function () {
			item = await createArticle({ title: 'A study of things', lastName: 'Quuxly', date: '2020' });
		});
		
		afterEach(async function () {
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
			
			it("should say when installing the style outlasts the call", async function () {
				sinon.stub(Permissions, '_ask').resolves('allow');
				let installing = Zotero.Promise.defer();
				sinon.stub(Zotero.Styles, 'install').returns(installing.promise);
				let error = await withBudget(300, () => callForError('zotero_generate_citation', {
					items: [{ key: item.key }],
					format: 'citation',
					style: 'zotero-mcp-test',
				}));
				assert.match(error, /still installing the style/);
				installing.resolve({ styleID: STYLE_ID });
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
	
	describe("zotero_update_items", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should change several items in one step the user can undo", async function () {
			let collection = await createDataObject('collection');
			let a = await createArticle({ title: 'Old A' });
			let b = await createArticle({ title: 'Old B', tags: [{ tag: 'old' }] });
			
			let { items } = await call('zotero_update_items', {
				changes: [
					{ key: a.key, fields: { title: 'New A', DOI: '10.1/x' }, addToCollections: [collection.key] },
					{
						key: b.key,
						creators: [{ creatorType: 'author', name: 'Org' }, { creatorType: 'editor', firstName: 'Bo', lastName: 'Ng' }],
						addTags: ['new'],
						removeTags: ['old'],
					},
				],
			});
			assert.deepEqual(items.map(item => item.key), [a.key, b.key]);
			assert.equal(items[0].title, 'New A');
			assert.equal(a.getField('DOI'), '10.1/x');
			assert.isTrue(collection.hasItem(a.id));
			assert.deepEqual(b.getTags(), [{ tag: 'new' }]);
			assert.deepEqual(b.getCreators().map(c => [c.lastName, c.fieldMode]), [['Org', 1], ['Ng', 0]]);
			assert.deepEqual(Zotero.UndoHistory.getUndoAction(), {
				action: 'undo-action-mcp-changes',
				actionArgs: { app: 'test-client' },
			});
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.equal(a.getField('title'), 'Old A');
			assert.equal(a.getField('DOI'), '');
			assert.isFalse(collection.hasItem(a.id));
			assert.deepEqual(b.getTags(), [{ tag: 'old' }]);
			assert.lengthOf(b.getCreators(), 0);
			assert.isFalse(Zotero.UndoHistory.canUndo());
		});
		
		it("should change nothing if any change is invalid", async function () {
			let a = await createArticle({ title: 'A' });
			let book = await createDataObject('item', { itemType: 'book', title: 'B' });
			let error = await callForError('zotero_update_items', {
				changes: [
					{ key: a.key, fields: { title: 'Changed' }, addTags: ['t'] },
					{ key: book.key, fields: { issue: '3' } },
				],
			});
			assert.match(error, new RegExp(`${book.key}: issue isn't a field of item type book`));
			assert.include(error, 'numPages');
			assert.equal(a.getField('title'), 'A');
			assert.isFalse(a.hasTag('t'));
			
			error = await callForError('zotero_update_items', {
				changes: [{ key: a.key, fields: { title: 'Changed' } }, { key: 'AAAAAAAA' }],
			});
			assert.match(error, /No item AAAAAAAA/);
			assert.equal(a.getField('title'), 'A');
			
			error = await callForError('zotero_update_items', {
				changes: [{ key: book.key, creators: [{ creatorType: 'director', lastName: 'X' }] }],
			});
			assert.match(error, /director isn't a creator type of item type book/);
		});
		
		it("should set a base field by the item type's own name for it", async function () {
			let section = await createDataObject('item', { itemType: 'bookSection' });
			await call('zotero_update_items', {
				changes: [{ key: section.key, fields: { publicationTitle: 'The Book' } }],
			});
			assert.equal(section.getField('bookTitle'), 'The Book');
		});
	});
	
	describe("zotero_manage_collections", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
		});
		
		it("should create, rename and move collections", async function () {
			let parent = await createDataObject('collection');
			let created = await call('zotero_manage_collections', { action: 'create', name: 'Reading', parentKey: parent.key });
			let collection = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, created.key);
			assert.equal(collection.name, 'Reading');
			assert.equal(collection.parentKey, parent.key);
			assert.equal(created.link, `zotero://select/library/collections/${created.key}`);
			
			await call('zotero_manage_collections', { action: 'rename', key: created.key, name: 'Read' });
			assert.equal(collection.name, 'Read');
			assert.equal(collection.parentKey, parent.key);
			
			await call('zotero_manage_collections', { action: 'move', key: created.key, parentKey: null });
			assert.isFalse(collection.parentKey);
			assert.equal(collection.name, 'Read');
		});
		
		it("shouldn't move a collection into its own subcollection", async function () {
			let parent = await createDataObject('collection');
			let child = await createDataObject('collection', { parentID: parent.id });
			let error = await callForError('zotero_manage_collections', { action: 'move', key: parent.key, parentKey: child.key });
			assert.match(error, /can't be moved into itself or a subcollection/);
			assert.isFalse(parent.parentKey);
		});
		
		it("should apply concurrent changes one after another, each its own undo step", async function () {
			let collection = await createDataObject('collection', { name: 'Original' });
			Zotero.UndoHistory.clear();
			// Hold a transaction, so both calls queue for theirs
			let release = Zotero.Promise.defer();
			let held = Zotero.DB.executeTransaction(() => release.promise);
			let first = call('zotero_manage_collections', { action: 'rename', key: collection.key, name: 'First' });
			let second = call('zotero_manage_collections', { action: 'rename', key: collection.key, name: 'Second' });
			await Zotero.Promise.delay(100);
			release.resolve();
			await held;
			assert.deepEqual((await Promise.all([first, second])).map(result => result.name), ['First', 'Second']);
			assert.equal(collection.name, 'Second');
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.equal(collection.name, 'First');
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.equal(collection.name, 'Original');
		});
	});
	
	describe("zotero_add_note", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
		});
		
		it("should add a child note from Markdown as the note editor stores it", async function () {
			let item = await createArticle();
			let markdown = '# Summary\n\nCosts $5 and $10, energy $E = mc^2$ for $m$, ~~not~~ see https://example.com\n\n'
				+ '$$\n\\frac{a}{b}\n$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<b>raw</b>';
			let result = await call('zotero_add_note', { markdown, parentKey: item.key });
			assert.equal(result.parentKey, item.key);
			assert.equal(result.title, 'Summary');
			let note = Zotero.Items.getByLibraryAndKey(item.libraryID, result.key);
			assert.equal(note.parentID, item.id);
			let html = note.getNote();
			assert.match(html, /^<div data-schema-version="9"><h1>Summary<\/h1>/);
			assert.include(html, 'Costs $5 and $10, energy <span class="math">$E = mc^2$</span> for $m$');
			assert.include(html, '<s>not</s>');
			assert.include(html, '<a href="https://example.com">https://example.com</a>');
			assert.include(html, '<pre class="math">$$\\frac{a}{b}$$</pre>');
			assert.include(html, '<td>1</td>');
			assert.include(html, '&lt;b&gt;raw&lt;/b&gt;');
		});
		
		it("should let the user undo adding a note", async function () {
			Zotero.UndoHistory.clear();
			let { key } = await call('zotero_add_note', { markdown: 'Ideas' });
			let note = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
			assert.deepEqual(Zotero.UndoHistory.getUndoAction(), {
				action: 'undo-action-mcp-changes',
				actionArgs: { app: 'test-client' },
			});
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(note.deleted);
		});
		
		it("should add a standalone note to a collection, but not under a note", async function () {
			let collection = await createDataObject('collection');
			let { key } = await call('zotero_add_note', { markdown: 'Ideas', collectionKey: collection.key });
			let note = Zotero.Items.getByLibraryAndKey(collection.libraryID, key);
			assert.isTrue(note.isTopLevelItem());
			assert.isTrue(collection.hasItem(note.id));
			
			let error = await callForError('zotero_add_note', { markdown: 'x', parentKey: key });
			assert.match(error, /is a note/);
		});
	});
	
	describe("zotero_trash", function () {
		beforeEach(function () {
			Zotero.UndoHistory.clear();
		});
		
		it("should ask to delete before trashing, and only to edit before restoring", async function () {
			let ask = sinon.stub(Permissions, '_ask').resolves('allow');
			let item = await createArticle();
			let note = await createDataObject('item', { itemType: 'note', parentID: item.id });
			
			await call('zotero_trash', { keys: [item.key] });
			assert.isTrue(ask.calledOnceWith('test-client', Permissions.DELETE, item.libraryID));
			assert.isTrue(item.deleted);
			assert.equal(Zotero.UndoHistory.getUndoAction().action, 'undo-action-mcp-changes');
			
			// Restoring an item restores its trashed children
			note.deleted = true;
			await note.saveTx();
			let { restored } = await call('zotero_trash', { keys: [item.key], restore: true });
			assert.isTrue(restored);
			assert.isTrue(ask.secondCall.calledWith('test-client', Permissions.EDIT_LIBRARY, item.libraryID));
			assert.isFalse(item.deleted);
			assert.isFalse(note.deleted);
			
			let error = await callForError('zotero_trash', { keys: [item.key], restore: true });
			assert.match(error, /isn't in the trash/);
		});
		
		it("should trash and restore a collection with its subcollections, leaving its items", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			let parent = await createDataObject('collection');
			let child = await createDataObject('collection', { parentID: parent.id });
			let item = await createArticle({ collections: [child.id] });
			
			let { collections } = await call('zotero_trash', { collectionKeys: [child.key, parent.key] });
			assert.deepEqual(collections, [parent.key]);
			assert.isTrue(parent.deleted);
			assert.isTrue(child.deleted);
			assert.isFalse(item.deleted);
			
			await call('zotero_trash', { collectionKeys: [parent.key], restore: true });
			assert.isFalse(parent.deleted);
			assert.isFalse(child.deleted);
		});
		
		it("should trash nothing if the user denies it", async function () {
			sinon.stub(Permissions, '_ask').resolves('deny');
			let item = await createArticle();
			let error = await callForError('zotero_trash', { keys: [item.key] });
			assert.match(error, /denied/);
			assert.isFalse(item.deleted);
		});
	});
	
	describe("zotero_add_items", function () {
		let lookups;
		// Lookups of 10.8888/ DOIs wait for it
		let slowLookups;
		
		beforeEach(function () {
			slowLookups = Promise.withResolvers();
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
			// Lookups need the network, so they make an item from the identifier instead
			lookups = [];
			sinon.stub(Zotero.Translate.Search.prototype, 'setIdentifier').callsFake(function (identifier) {
				this._testIdentifier = identifier;
			});
			sinon.stub(Zotero.Translate.Search.prototype, 'getTranslators').resolves([]);
			sinon.stub(Zotero.Translate.Search.prototype, 'translate').callsFake(async function ({ libraryID, collections }) {
				let identifier = this._testIdentifier;
				lookups.push(identifier);
				if (identifier.DOI?.startsWith('10.9999/')) {
					throw new Error('Not found');
				}
				if (identifier.DOI?.startsWith('10.8888/')) {
					await slowLookups.promise;
				}
				let item = createUnsavedDataObject('item', { itemType: 'journalArticle', libraryID, collections: collections || [] });
				item.setField('title', 'Looked Up');
				if (identifier.DOI) {
					item.setField('DOI', identifier.DOI);
				}
				await item.saveTx();
				return [item];
			});
		});
		
		it("should add items by identifier, in one undo step", async function () {
			let collection = await createDataObject('collection');
			let doi = '10.1234/' + Zotero.Utilities.randomString();
			let existing = await createArticle();
			existing.setField('DOI', doi);
			await existing.saveTx();
			let newDOI = '10.1234/' + Zotero.Utilities.randomString();
			
			let { results } = await call('zotero_add_items', {
				identifiers: [`https://doi.org/${newDOI}`, doi, '10.9999/missing', 'https://example.com/page'],
				collectionKey: collection.key,
				findFiles: false,
			});
			assert.deepEqual(results.map(result => result.status), ['added', 'added', 'failed', 'failed']);
			assert.match(results[2].error, /couldn't find DOI 10\.9999\/missing/);
			assert.match(results[3].error, /Zotero Connector/);
			// An item already in the library is added again, as when the user adds it
			assert.deepEqual(lookups, [{ DOI: newDOI }, { DOI: doi }, { DOI: '10.9999/missing' }]);
			assert.notEqual(results[1].key, existing.key);
			
			let added = results.slice(0, 2).map(result => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, result.key));
			assert.deepEqual(added.map(item => item.getField('DOI')), [newDOI, doi]);
			assert.isTrue(added.every(item => collection.hasItem(item.id)));
			assert.isFalse(collection.hasItem(existing.id));
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(added.every(item => item.deleted));
			assert.isFalse(existing.deleted);
		});
		
		it("should return lookups still running as inProgress, and add their items later as another undo step", async function () {
			let collection = await createDataObject('collection');
			let slowDOI = '10.8888/' + Zotero.Utilities.randomString();
			let fastDOI = '10.1234/' + Zotero.Utilities.randomString();
			let budget = Zotero.MCP.CALL_BUDGET;
			Zotero.MCP.CALL_BUDGET = 500;
			let result;
			try {
				result = await call('zotero_add_items', {
					identifiers: [slowDOI, fastDOI],
					collectionKey: collection.key,
					findFiles: false,
				});
			}
			finally {
				Zotero.MCP.CALL_BUDGET = budget;
			}
			// The slow lookup didn't hold up the one after it
			assert.deepEqual(result.results.map(result => [result.input, result.status]), [
				[slowDOI, 'inProgress'],
				[fastDOI, 'added'],
			]);
			assert.match(result.notice, /still looking up/);
			let fast = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, result.results[1].key);
			
			slowLookups.resolve();
			await waitForCallback(() => Zotero.UndoHistory._undoStack.length == 2);
			let slow = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID))
				.find(item => item.getField('DOI') == slowDOI);
			assert.isTrue(collection.hasItem(slow.id));
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(slow.deleted);
			assert.isFalse(fast.deleted);
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(fast.deleted);
		});
		
		it("should add items from BibTeX and item JSON", async function () {
			let title = Zotero.Utilities.randomString();
			let { results } = await call('zotero_add_items', {
				text: `@book{lee2020, title = {${title} Book}, author = {Lee, Ann}, year = {2020}}`,
				items: [{
					itemType: 'report',
					title: `${title} Report`,
					creators: [{ creatorType: 'author', name: 'Org' }],
					institution: 'Inst',
					key: 'ABCD2345',
					dateAdded: '2020-01-01T00:00:00Z',
				}],
				findFiles: false,
			});
			assert.deepEqual(results.map(result => [result.input, result.status, result.itemType, result.title]), [
				['text', 'added', 'book', `${title} Book`],
				['items[0]', 'added', 'report', `${title} Report`],
			]);
			let report = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, results[1].key);
			assert.notEqual(report.key, 'ABCD2345');
			assert.equal(report.getField('institution'), 'Inst');
		});
		
		it("should add nothing if item JSON is invalid", async function () {
			let error = await callForError('zotero_add_items', {
				identifiers: ['10.1234/abc'],
				items: [{ itemType: 'book', title: 'A' }, { itemType: 'book', publicationTitle: 'Journal' }],
			});
			assert.match(error, /^items\[1\]: Invalid field 'publicationTitle' for type book/);
			assert.lengthOf(lookups, 0);
		});
		
		it("should say when Zotero found no file, or is still looking", async function () {
			let search = sinon.stub(Zotero.Attachments, 'addAvailableFiles').resolves();
			let item = { itemType: 'webpage', title: 'Page', url: 'https://example.com/' + Zotero.Utilities.randomString() };
			let result = await call('zotero_add_items', { items: [item], findFiles: true });
			assert.equal(search.firstCall.args[0][0].key, result.results[0].key);
			assert.equal(result.results[0].fileSearch, 'notFound');
			assert.match(result.notice, /zotero_add_attachment/);
			
			// The time the user takes to answer the permission dialog comes out of the call's
			// budget, so the file search is waited for only for what's left of it
			let budget = Zotero.MCP.CALL_BUDGET;
			Zotero.MCP.CALL_BUDGET = 1000;
			Permissions._ask.callsFake(() => Zotero.Promise.delay(800).then(() => 'allow'));
			search.returns(new Promise(() => {}));
			let start = Date.now();
			try {
				item.url += '2';
				result = await call('zotero_add_items', { items: [item], findFiles: true });
			}
			finally {
				Zotero.MCP.CALL_BUDGET = budget;
			}
			assert.isBelow(Date.now() - start, 1500);
			assert.equal(result.results[0].fileSearch, 'searching');
			assert.match(result.notice, /still looking/);
		});
	});
	
	describe("zotero_add_attachment", function () {
		let parent;
		
		beforeEach(async function () {
			Zotero.UndoHistory.clear();
			parent = await createArticle();
		});
		
		it("should attach a PDF from a URL", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			let { httpd, baseURL } = await startHTTPServer();
			let prefix = Zotero.Utilities.randomString();
			let file = getTestDataDirectory();
			file.append('test.pdf');
			httpd.registerFile(`/${prefix}/paper.pdf`, file);
			try {
				let result = await call('zotero_add_attachment', {
					parentKey: parent.key,
					url: `${baseURL}${prefix}/paper.pdf`,
					title: 'Preprint',
				});
				assert.equal(result.status, 'attached');
				assert.equal(result.contentType, 'application/pdf');
				assert.equal(result.title, 'Preprint');
				let attachment = Zotero.Items.getByLibraryAndKey(parent.libraryID, result.key);
				assert.equal(attachment.parentID, parent.id);
				assert.isTrue(await attachment.fileExists());
				
				assert.isTrue(await Zotero.UndoHistory.undo());
				assert.isTrue(attachment.deleted);
			}
			finally {
				await new Promise(resolve => httpd.stop(resolve));
			}
		});
		
		it("should title a download that outlasts the call, and make it an undo step", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			let download = Zotero.Promise.defer();
			sinon.stub(Zotero.Attachments, 'addFileFromURLs').returns(download.promise);
			let budget = Zotero.MCP.CALL_BUDGET;
			Zotero.MCP.CALL_BUDGET = 200;
			let result;
			try {
				result = await call('zotero_add_attachment', {
					parentKey: parent.key,
					url: 'https://example.com/paper.pdf',
					title: 'Preprint',
				});
			}
			finally {
				Zotero.MCP.CALL_BUDGET = budget;
			}
			assert.equal(result.status, 'downloading');
			
			let file = getTestDataDirectory();
			file.append('test.pdf');
			let attachment = await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id });
			download.resolve(attachment);
			await waitForCallback(() => Zotero.UndoHistory.canUndo());
			assert.equal(attachment.getField('title'), 'Preprint');
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(attachment.deleted);
		});
		
		it("should attach a file from this computer", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			let file = getTestDataDirectory();
			file.append('test.pdf');
			let result = await call('zotero_add_attachment', { parentKey: parent.key, path: file.path });
			let attachment = Zotero.Items.getByLibraryAndKey(parent.libraryID, result.key);
			assert.equal(attachment.parentID, parent.id);
			assert.isTrue(await attachment.fileExists());
			
			let error = await callForError('zotero_add_attachment', { parentKey: parent.key, path: 'test.pdf' });
			assert.match(error, /isn't an absolute path/);
			let missing = PathUtils.join(PathUtils.parent(file.path), 'missing.pdf');
			error = await callForError('zotero_add_attachment', { parentKey: parent.key, path: missing });
			assert.match(error, /There's no file at/);
		});
	});
});
