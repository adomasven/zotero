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
	
	describe("zotero_list_item_types", function () {
		it("should list each item type's fields and creator types", async function () {
			let { itemTypes } = await call('zotero_list_item_types', { itemTypes: ['bookSection'] });
			assert.lengthOf(itemTypes, 1);
			let [type] = itemTypes;
			assert.equal(type.itemType, 'bookSection');
			assert.equal(type.label, 'Book Section');
			assert.deepInclude(type.fields, { field: 'bookTitle', label: 'Book Title', baseField: 'publicationTitle' });
			assert.deepInclude(type.fields, { field: 'title', label: 'Title' });
			assert.notInclude(type.fields.map(field => field.field), 'issue');
			assert.deepInclude(type.creatorTypes, { creatorType: 'author', label: 'Author', primary: true });
			assert.deepInclude(type.creatorTypes, { creatorType: 'bookAuthor', label: 'Book Author' });
			
			({ itemTypes } = await call('zotero_list_item_types', {}));
			let names = itemTypes.map(type => type.itemType);
			assert.includeMembers(names, ['book', 'journalArticle', 'webpage']);
			assert.notInclude(names, 'note');
		});
		
		it("should be the item types tools.json takes, which should be all of Zotero's but notes, attachments and annotations", async function () {
			let expected = Zotero.ItemTypes.getAll()
				.map(type => type.name)
				.filter(name => !['note', 'attachment', 'annotation'].includes(name))
				.sort();
			let { itemTypes } = await call('zotero_list_item_types', {});
			assert.sameMembers(itemTypes.map(type => type.itemType), expected);
			
			// Every list of item types in an input schema, e.g. after a schema update adds a type
			let enums = [];
			let findEnums = (schema) => {
				if (Array.isArray(schema?.enum) && schema.enum.includes('journalArticle')) {
					enums.push(schema.enum);
				}
				else if (schema && typeof schema == 'object') {
					Object.values(schema).forEach(findEnums);
				}
			};
			let tools = await Zotero.MCP.getTools();
			for (let tool of tools) {
				findEnums(tool.inputSchema);
			}
			assert.lengthOf(enums, 3);
			for (let itemTypeEnum of enums) {
				assert.deepEqual([...itemTypeEnum].sort(), expected);
			}
		});
	});
	
	describe("zotero_search", function () {
		it("should give each item's best attachment, and how many attachments, notes and annotations it has", async function () {
			let collection = await createDataObject('collection');
			let item = await createArticle({ collections: [collection.id] });
			let link = await Zotero.Attachments.linkFromURL({ url: 'https://example.com/', parentItemID: item.id });
			let pdf = await importFileAttachment('test.pdf', { parentID: item.id });
			await createAnnotation('highlight', pdf);
			await createAnnotation('note', pdf);
			await createDataObject('item', { itemType: 'note', parentID: item.id });
			
			let { items } = await call('zotero_search', { collectionKey: collection.key });
			assert.deepInclude(items[0], {
				bestAttachment: { key: pdf.key, contentType: 'application/pdf' },
				attachmentCount: 2,
				noteCount: 1,
				annotationCount: 2,
			});
			assert.notProperty(items[0], 'citationKey');
			assert.isOk(link);
		});
		
		it("should filter by conditions, groups of them and levels, with annotation types by name", async function () {
			let tag = Zotero.Utilities.randomString();
			let annotationTag = Zotero.Utilities.randomString();
			let annotated = await createArticle({ lastName: 'Smith' });
			let pdf = await importFileAttachment('test.pdf', { parentID: annotated.id });
			let highlight = await createAnnotation('highlight', pdf);
			highlight.addTag(annotationTag);
			await highlight.saveTx();
			let unattached = await createArticle();
			// Has an annotation, but not a highlight
			let noted = await createArticle();
			await createAnnotation('note', await importFileAttachment('test.pdf', { parentID: noted.id }));
			for (let item of [annotated, unattached, noted]) {
				item.addTag(tag);
				await item.saveTx();
			}
			let tagged = { condition: 'tag', operator: 'is', value: tag };
			
			let { items } = await call('zotero_search', { conditions: [tagged, {
				joinMode: 'any',
				conditions: [
					{ condition: 'annotationType', operator: 'is', value: 'highlight' },
					{ condition: 'numAttachments', operator: 'is', value: '0' },
				],
			}] });
			assert.sameMembers(items.map(item => item.key), [annotated.key, unattached.key]);
			assert.equal(items.find(item => item.key == annotated.key).creatorSummary, 'Smith');
			
			({ items } = await call('zotero_search', { conditions: [{ ...tagged, value: annotationTag, level: 'annotation' }] }));
			assert.deepEqual(items.map(item => item.key), [annotated.key]);
			({ items } = await call('zotero_search', { conditions: [{ ...tagged, level: 'annotation' }] }));
			assert.lengthOf(items, 0);
			
			assert.match(
				await callForError('zotero_search', { conditions: [{ condition: 'tag', operator: 'isBefore', value: '2020' }] }),
				/tag takes the operators is, isNot, contains, doesNotContain/
			);
		});
		
		it("should return an item once for matches in its notes, and the notes for itemType is note", async function () {
			let word = Zotero.Utilities.randomString();
			let item = await createArticle();
			let notes = [];
			for (let i = 0; i < 2; i++) {
				notes.push(await createDataObject('item', { itemType: 'note', parentID: item.id, note: `<p>${word}</p>` }));
			}
			let inNote = { condition: 'note', operator: 'contains', value: word };
			
			let { items } = await call('zotero_search', { conditions: [inNote] });
			assert.deepEqual(items.map(item => item.key), [item.key]);
			
			({ items } = await call('zotero_search', { conditions: [{ condition: 'itemType', operator: 'is', value: 'note' }, inNote] }));
			assert.sameMembers(items.map(item => item.key), notes.map(note => note.key));
			assert.isTrue(items.every(note => note.parentKey == item.key));
			
			let pdf = await importFileAttachment('test.pdf', { parentID: item.id });
			let annotation = await createAnnotation('note', pdf, { comment: word });
			({ items } = await call('zotero_search', { conditions: [
				{ condition: 'itemType', operator: 'is', value: 'annotation' },
				{ condition: 'annotationComment', operator: 'contains', value: word },
			] }));
			assert.deepEqual(items.map(each => [each.key, each.attachmentKey, each.parentKey]), [[annotation.key, pdf.key, undefined]]);
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
			
			let page = await call('zotero_search', { collectionKey: collection.key, sortField: 'title', limit: 2 });
			assert.equal(page.total, 3);
			assert.deepEqual(page.items.map(item => item.key), [a, b]);
			assert.equal(page.nextOffset, 2);
			
			page = await call('zotero_search', { collectionKey: collection.key, sortField: 'title', sortDirection: 'desc', limit: 2 });
			assert.deepEqual(page.items.map(item => item.key), [c, b]);
			page = await call('zotero_search', { collectionKey: collection.key, sortField: 'title', sortDirection: 'desc', limit: 2, offset: 2 });
			assert.deepEqual(page.items.map(item => item.key), [a]);
			assert.notProperty(page, 'nextOffset');
			
			let titled = [{ condition: 'title', operator: 'contains', value: prefix }];
			assert.equal((await call('zotero_search', { conditions: titled, collectionKey: collection.key })).total, 3);
			assert.equal((await call('zotero_search', { conditions: titled })).total, 4);
		});
		
		it("should search the given library, and not the trash", async function () {
			let group = await getGroup();
			let title = Zotero.Utilities.randomString();
			let inGroup = await createArticle({ title, libraryID: group.libraryID });
			await createArticle({ title, deleted: true });
			
			let conditions = [{ condition: 'title', operator: 'is', value: title }];
			assert.equal((await call('zotero_search', { conditions })).total, 0);
			let { items } = await call('zotero_search', { conditions, libraryID: group.libraryID });
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
			
			let { items, missing } = await call('zotero_get_items', { itemKeys: [item.key, 'AAAAAAAA'] });
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
				path: attachment.getFilePath(),
				annotationCount: 0,
			}]);
			assert.deepEqual(items[0].notes, [{ key: note.key, title: 'My note' }]);
		});
		
		it("should leave out items in the trash unless asked for them", async function () {
			let item = await createArticle();
			item.deleted = true;
			await item.saveTx();
			
			let { items, missing } = await call('zotero_get_items', { itemKeys: [item.key] });
			assert.lengthOf(items, 0);
			assert.deepEqual(missing, [item.key]);
			
			({ items, missing } = await call('zotero_get_items', { itemKeys: [item.key], includeTrashed: true }));
			assert.equal(items[0].key, item.key);
			assert.isTrue(items[0].deleted);
			assert.isUndefined(missing);
		});
	});
	
	describe("duplicates", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should list duplicates and merge them into the oldest, and undo", async function () {
			let DOI = '10.1234/' + Zotero.Utilities.randomString();
			let older = await createDataObject('item', { title: 'Merge me', dateAdded: '2020-01-01 00:00:00' });
			older.setField('DOI', DOI);
			await older.saveTx();
			let newer = await createDataObject('item', { title: 'Merge me (copy)' });
			newer.setField('DOI', DOI);
			newer.addTag('copied');
			await newer.saveTx();
			let note = await createDataObject('item', { itemType: 'note', parentID: newer.id });
			
			let sets = [];
			for (let offset = 0; offset !== undefined;) {
				let result = await call('zotero_list_duplicates', { offset, limit: 100 });
				sets.push(...result.sets);
				offset = result.nextOffset;
			}
			let set = sets.find(set => set.some(item => item.key == older.key));
			assert.deepEqual(set.map(item => item.key), [older.key, newer.key]);
			assert.equal(set[0].DOI, DOI);
			assert.equal(set[1].noteCount, 1);
			
			let result = await call('zotero_merge_items', { itemKeys: [newer.key, older.key] });
			assert.equal(result.key, older.key);
			assert.deepEqual(result.trashed, [newer.key]);
			assert.isTrue(newer.deleted);
			assert.equal(note.parentID, older.id);
			assert.isTrue(older.hasTag('copied'));
			
			assert.deepEqual(Zotero.UndoHistory.getUndoAction(), {
				action: 'undo-action-mcp-changes',
				actionArgs: { app: 'test-client' },
			});
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isFalse(newer.deleted);
			assert.equal(note.parentID, newer.id);
		});
		
		it("should refuse to merge items of different types", async function () {
			let a = await createDataObject('item', { itemType: 'book' });
			let b = await createDataObject('item', { itemType: 'journalArticle' });
			assert.match(
				await callForError('zotero_merge_items', { itemKeys: [a.key, b.key] }),
				/different types.*zotero_change_item_types/
			);
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
		
		it("should return lookups still running as pending, and add their items later as another undo step", async function () {
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
				[slowDOI, 'pending'],
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
		
		it("should add items from item JSON", async function () {
			let title = Zotero.Utilities.randomString();
			let { results } = await call('zotero_add_items', {
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
				['items[0]', 'added', 'report', `${title} Report`],
			]);
			let report = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, results[0].key);
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
			assert.deepEqual(result.results[0].attachments, []);
			assert.notProperty(result.results[0], 'bestAttachment');
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
			assert.equal(result.results[0].fileSearch, 'pending');
			assert.match(result.notice, /still looking/);
		});
	});
	
	describe("zotero_update_items", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should tag an annotation, and give its file", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let annotation = await createAnnotation('highlight', attachment);
			let { items } = await call('zotero_update_items', { changes: [{ key: annotation.key, addTags: ['figure'] }] });
			assert.deepInclude(items[0], { key: annotation.key, attachmentKey: attachment.key });
			assert.deepEqual(annotation.getTags(), [{ tag: 'figure' }]);
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
	
	describe("zotero_change_item_types", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should change types in one step the user can undo, and say which fields moved or were removed", async function () {
			let article = await createArticle({ title: 'T' });
			article.setField('publicationTitle', 'The Book');
			article.setField('issue', '3');
			article.setCreators([
				{ creatorType: 'author', firstName: 'Ann', lastName: 'Lee' },
				{ creatorType: 'reviewedAuthor', firstName: 'Bo', lastName: 'Ng' },
			]);
			await article.saveTx();
			// book -> bookSection moves the title to bookTitle, which isn't a base field mapping
			let book = await createDataObject('item', { itemType: 'book', title: 'B' });
			book.setField('shortTitle', 'S');
			await book.saveTx();
			
			let { items } = await call('zotero_change_item_types', {
				changes: [{ key: article.key, itemType: 'bookSection' }, { key: book.key, itemType: 'bookSection' }],
			});
			assert.equal(article.itemType, 'bookSection');
			assert.equal(article.getField('bookTitle'), 'The Book');
			assert.equal(article.getField('title'), 'T');
			assert.deepInclude(items[0], {
				key: article.key,
				itemType: 'bookSection',
				oldItemType: 'journalArticle',
				movedFields: { publicationTitle: 'bookTitle' },
				removedFields: { issue: '3' },
				changedCreatorTypes: [{ name: 'Bo Ng', from: 'reviewedAuthor', to: 'contributor' }],
			});
			assert.equal(book.getField('bookTitle'), 'B');
			assert.deepInclude(items[1], {
				movedFields: { title: 'bookTitle' },
				removedFields: { shortTitle: 'S' },
				changedCreatorTypes: [],
			});
			assert.deepEqual(Zotero.UndoHistory.getUndoAction(), {
				action: 'undo-action-mcp-changes',
				actionArgs: { app: 'test-client' },
			});
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.equal(article.itemType, 'journalArticle');
			assert.equal(article.getField('publicationTitle'), 'The Book');
			assert.equal(article.getField('issue'), '3');
			assert.equal(Zotero.CreatorTypes.getName(article.getCreator(1).creatorTypeID), 'reviewedAuthor');
			assert.equal(book.itemType, 'book');
			assert.equal(book.getField('title'), 'B');
			assert.isFalse(Zotero.UndoHistory.canUndo());
		});
		
		it("should change nothing if any item's type can't be changed", async function () {
			let article = await createArticle({ title: 'T' });
			let note = await createDataObject('item', { itemType: 'note' });
			let error = await callForError('zotero_change_item_types', {
				changes: [{ key: article.key, itemType: 'book' }, { key: note.key, itemType: 'book' }],
			});
			assert.match(error, new RegExp(`${note.key} is a note, whose type can't be changed`));
			assert.equal(article.itemType, 'journalArticle');
			
			error = await callForError('zotero_change_item_types', {
				changes: [{ key: article.key, itemType: 'note' }],
			});
			assert.include(error, 'itemType');
			assert.equal(article.itemType, 'journalArticle');
		});
	});
	
	describe("zotero_list_collections", function () {
		it("should list a collection's subcollections at any depth, with item counts", async function () {
			let parent = await createDataObject('collection');
			let child = await createDataObject('collection', { parentID: parent.id });
			let grandchild = await createDataObject('collection', { parentID: child.id });
			await createDataObject('collection');
			await createArticle({ collections: [grandchild.id] });
			
			let { collections } = await call('zotero_list_collections', { collectionKey: parent.key });
			assert.sameDeepMembers(collections, [
				{ key: child.key, name: child.name, parentKey: parent.key, itemCount: 0, link: `zotero://select/library/collections/${child.key}` },
				{ key: grandchild.key, name: grandchild.name, parentKey: child.key, itemCount: 1, link: `zotero://select/library/collections/${grandchild.key}` },
			]);
			
			// Whatever the user's setting for showing items from subcollections
			Zotero.Prefs.set('recursiveCollections', true);
			try {
				({ collections } = await call('zotero_list_collections', { collectionKey: parent.key }));
				assert.equal(collections.find(c => c.key == child.key).itemCount, 0);
				assert.lengthOf((await call('zotero_search', { collectionKey: child.key })).items, 0);
			}
			finally {
				Zotero.Prefs.clear('recursiveCollections');
			}
			({ collections } = await call('zotero_list_collections', { collectionKey: parent.key, includeSubcollectionItems: true }));
			assert.equal(collections.find(c => c.key == child.key).itemCount, 1);
			assert.lengthOf(
				(await call('zotero_search', { collectionKey: child.key, includeSubcollectionItems: true })).items, 1
			);
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
			
			await call('zotero_manage_collections', { action: 'update', collectionKey: created.key, name: 'Read' });
			assert.equal(collection.name, 'Read');
			assert.equal(collection.parentKey, parent.key);
			
			await call('zotero_manage_collections', { action: 'update', collectionKey: created.key, parentKey: null });
			assert.isFalse(collection.parentKey);
			assert.equal(collection.name, 'Read');
		});
		
		it("shouldn't move a collection into its own subcollection", async function () {
			let parent = await createDataObject('collection');
			let child = await createDataObject('collection', { parentID: parent.id });
			let error = await callForError('zotero_manage_collections', { action: 'update', collectionKey: parent.key, parentKey: child.key });
			assert.match(error, /can't be moved into itself or a subcollection/);
			assert.isFalse(parent.parentKey);
		});
		
		it("should apply concurrent changes one after another, each its own undo step", async function () {
			let collection = await createDataObject('collection', { name: 'Original' });
			Zotero.UndoHistory.clear();
			// Hold a transaction, so both calls queue for theirs
			let release = Zotero.Promise.defer();
			let held = Zotero.DB.executeTransaction(() => release.promise);
			let first = call('zotero_manage_collections', { action: 'update', collectionKey: collection.key, name: 'First' });
			let second = call('zotero_manage_collections', { action: 'update', collectionKey: collection.key, name: 'Second' });
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
				{ name: colored, itemCount: 0, color: 'red' },
				{ name: two, itemCount: 2 },
				{ name: one, itemCount: 1 },
			]);
		});
	});
	
	describe("zotero_manage_tags", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should merge tags into one, keeping a color, and undo", async function () {
			let [a, b, c] = ['ML', 'machine-learning', 'Machine Learning'].map(() => Zotero.Utilities.randomString());
			let one = await createDataObject('item', { tags: [{ tag: a }] });
			let two = await createDataObject('item', { tags: [{ tag: b }, { tag: c }] });
			let libraryID = Zotero.Libraries.userLibraryID;
			await Zotero.Tags.setColor(libraryID, a, '#ff6666', 0);
			try {
				let result = await call('zotero_manage_tags', { action: 'rename', tags: [a, b], newName: c });
				assert.equal(result.itemCount, 2);
				assert.deepEqual(one.getTags(), [{ tag: c }]);
				assert.deepEqual(two.getTags(), [{ tag: c }]);
				assert.equal(Zotero.Tags.getColor(libraryID, c).color, '#ff6666');
				assert.isFalse(Zotero.Tags.getColor(libraryID, a));
				
				assert.isTrue(await Zotero.UndoHistory.undo());
				assert.deepEqual(one.getTags(), [{ tag: a }]);
				assert.sameDeepMembers(two.getTags(), [{ tag: b }, { tag: c }]);
				
				assert.match(
					await callForError('zotero_manage_tags', { action: 'rename', tags: ['no such tag'], newName: c }),
					/No items in .* have the tags "no such tag"/
				);
				assert.match(
					await callForError('zotero_manage_tags', { action: 'rename', tags: [c] }),
					/Give newName to rename/
				);
			}
			finally {
				await Zotero.Tags.setColor(libraryID, a, false);
				await Zotero.Tags.setColor(libraryID, c, false);
			}
		});
		
		it("should delete tags and set colors", async function () {
			let tag = Zotero.Utilities.randomString();
			let item = await createDataObject('item', { tags: [{ tag }, { tag: 'kept' }] });
			let libraryID = Zotero.Libraries.userLibraryID;
			let result = await call('zotero_manage_tags', { action: 'setColor', tags: [tag], color: 'green' });
			assert.equal(result.color, 'green');
			assert.equal(Zotero.Tags.getColor(libraryID, tag).color, '#5FB236');
			assert.isAbove(result.position, 0);
			
			// A position alone moves the color to another number key and keeps it
			let position = result.position == 9 ? 8 : 9;
			result = await call('zotero_manage_tags', { action: 'setColor', tags: [tag], position });
			assert.equal(result.color, 'green');
			assert.equal(Zotero.Tags.getColor(libraryID, tag).color, '#5FB236');
			assert.match(
				await callForError('zotero_manage_tags', { action: 'setColor', tags: ['kept'], position: 1 }),
				/kept has no color/
			);
			// Only the colors Zotero offers, by name
			await callForError('zotero_manage_tags', { action: 'setColor', tags: [tag], color: '#5fb236' });
			
			await call('zotero_manage_tags', { action: 'delete', tags: [tag] });
			assert.deepEqual(item.getTags(), [{ tag: 'kept' }]);
			assert.isFalse(Zotero.Tags.getColor(libraryID, tag));
		});
	});
	
	describe("saved searches", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should create a saved search from conditions, list it, change it and trash it", async function () {
			let tag = Zotero.Utilities.randomString();
			let title = Zotero.Utilities.randomString();
			await createDataObject('item', { title, tags: [{ tag }] });
			await createDataObject('item', { tags: [{ tag }] });
			let name = Zotero.Utilities.randomString();
			let tagged = { condition: 'tag', operator: 'is', value: tag };
			let created = await call('zotero_manage_saved_searches', {
				action: 'create',
				name,
				conditions: [tagged, { condition: 'numNotes', operator: 'is', value: '0' }],
			});
			assert.equal(created.itemCount, 2);
			let { savedSearches } = await call('zotero_list_saved_searches', {});
			let listed = savedSearches.find(search => search.key == created.key);
			assert.equal(listed.name, name);
			assert.notProperty(listed, 'itemCount');
			let found = await call('zotero_search', { savedSearchKey: created.key });
			assert.equal(found.total, 2);
			assert.deepInclude(listed.conditions, { condition: 'tag', operator: 'is', value: tag });
			
			let updated = await call('zotero_manage_saved_searches', {
				action: 'update',
				savedSearchKey: created.key,
				conditions: [tagged, { condition: 'title', operator: 'contains', value: title }],
			});
			assert.equal(updated.name, name);
			assert.equal(updated.itemCount, 1);
			assert.isTrue(await Zotero.UndoHistory.undo());
			let search = Zotero.Searches.getByLibraryAndKey(Zotero.Libraries.userLibraryID, created.key);
			assert.equal((await search.search()).length, 2);
			
			let result = await call('zotero_trash', { savedSearchKeys: [created.key] });
			assert.deepEqual(result.savedSearchKeys, [created.key]);
			assert.isTrue(search.deleted);
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
			
			let result = await call('zotero_get_notes', { itemKeys: [item.key, 'AAAAAAAA'] });
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
				tags: ['important'],
				link: `zotero://open/library/items/${attachment.key}?annotation=${last.key}`,
			});
			
			result = await call('zotero_get_notes', { itemKeys: [note.key], format: 'html' });
			assert.include(result.notes[0].content, '<strong>bold</strong>');
			assert.lengthOf(result.annotations, 0);
		});
	});
	
	describe("annotation and note images", function () {
		it("should give rendered images' paths, and render the others on request", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let rendered = await createAnnotation('image', attachment);
			let unrendered = await createAnnotation('image', attachment);
			let png = await File.createFromFileName(getTestDataDirectory().path + '/test.png');
			await Zotero.Annotations.saveCacheImage(rendered, png);
			let render = sinon.stub(Zotero.PDFWorker, 'renderAttachmentAnnotations').callsFake(async () => {
				await Zotero.Annotations.saveCacheImage(unrendered, png);
				return 1;
			});
			try {
				let { annotations } = await call('zotero_get_notes', { itemKeys: [attachment.key] });
				let byKey = Object.fromEntries(annotations.map(annotation => [annotation.key, annotation]));
				assert.equal(byKey[rendered.key].imagePath, Zotero.Annotations.getCacheImagePath(rendered));
				assert.notProperty(byKey[unrendered.key], 'imagePath');
				assert.isFalse(render.called);
				
				let { images, missing } = await call('zotero_render_annotation_images', { itemKeys: [unrendered.key, 'AAAAAAAA'] });
				assert.deepEqual(missing, ['AAAAAAAA']);
				assert.isTrue(render.calledOnceWith(attachment.id));
				assert.deepEqual(images, [{
					key: unrendered.key,
					path: Zotero.Annotations.getCacheImagePath(unrendered),
					status: 'rendered',
				}]);
				assert.isTrue(await IOUtils.exists(images[0].path));
			}
			finally {
				render.restore();
			}
		});
		
		it("should list a note's images in order with their files", async function () {
			let note = await createDataObject('item', { itemType: 'note' });
			let first = await createEmbeddedImage(note);
			let second = await createEmbeddedImage(note);
			note.setNote(`<div data-schema-version="9"><p>A</p><img data-attachment-key="${second.key}"/>`
				+ `<p>B</p><img data-attachment-key="${first.key}"/></div>`);
			await note.saveTx();
			let { notes } = await call('zotero_get_notes', { itemKeys: [note.key] });
			assert.deepEqual(notes[0].images, [
				{ key: second.key, path: await second.getFilePathAsync() },
				{ key: first.key, path: await first.getFilePathAsync() },
			]);
			assert.match(notes[0].content, /\[image\][\s\S]*\[image\]/);
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
			
			// Its dateModified is the one zotero_edit_note checks
			await call('zotero_edit_note', { itemKey: result.key, markdown: 'More', dateModified: result.dateModified });
			assert.include(note.getNote(), '<p>More</p>');
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
	
	describe("zotero_edit_note", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should append inside the note's wrapper, and undo", async function () {
			let note = new Zotero.Item('note');
			let citationItems = 'data-citation-items="%5B%5D"';
			note.setNote(`<div ${citationItems} data-schema-version="8"><h1>Notes</h1><p>One</p></div>`);
			await note.saveTx();
			let [{ dateModified }] = (await call('zotero_get_notes', { itemKeys: [note.key] })).notes;
			let result = await call('zotero_edit_note', { itemKey: note.key, markdown: 'Two **more**', dateModified });
			assert.equal(result.title, 'Notes');
			assert.equal(
				note.getNote(),
				`<div ${citationItems} data-schema-version="8"><h1>Notes</h1><p>One</p><p>Two <strong>more</strong></p>\n</div>`
			);
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.include(note.getNote(), '<p>One</p></div>');
		});
		
		it("should leave the note as it was when saving it fails", async function () {
			let note = await createDataObject('item', { itemType: 'note', note: '<p>Old</p>' });
			let dateModified = Zotero.Date.sqlToISO8601(note.dateModified);
			sinon.stub(note, 'save').rejects(new Error('Save failed'));
			let { error, result } = await callMCPTool('zotero_edit_note', { itemKey: note.key, markdown: 'New', dateModified });
			assert.isTrue(error !== undefined || result.isError);
			assert.equal(note.getNote(), '<p>Old</p>');
		});
		
		it("should refuse to edit a note that changed since it was read", async function () {
			let note = await createDataObject('item', { itemType: 'note', note: '<p>Old</p>' });
			let [{ dateModified }] = (await call('zotero_get_notes', { itemKeys: [note.key] })).notes;
			note.setNote('<p>The user\'s edit</p>');
			note.setField('dateModified', '2099-01-01 00:00:00');
			await note.saveTx({ skipDateModifiedUpdate: true });
			let error = await callForError('zotero_edit_note', { itemKey: note.key, markdown: 'New', mode: 'replace', dateModified });
			assert.match(error, /has changed since/);
			assert.equal(note.getNote(), '<p>The user\'s edit</p>');
		});
		
		it("should replace a note, but not one with highlights", async function () {
			let note = await createDataObject('item', { itemType: 'note', note: '<p>Old</p>' });
			let dateModified = Zotero.Date.sqlToISO8601(note.dateModified);
			let result = await call('zotero_edit_note', { itemKey: note.key, markdown: '# New', mode: 'replace', dateModified });
			assert.equal(note.getNote(), '<div data-schema-version="9"><h1>New</h1>\n</div>');
			
			note.setNote('<div data-schema-version="9"><p><span class="highlight" data-annotation="%7B%7D">Quote</span></p></div>');
			await note.saveTx();
			let error = await callForError('zotero_edit_note', {
				itemKey: note.key, markdown: 'New', mode: 'replace', dateModified: Zotero.Date.sqlToISO8601(note.dateModified),
			});
			assert.match(error, /can't hold/);
			assert.notEqual(result.dateModified, undefined);
		});
	});
	
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
			
			let { total, files: results } = await call('zotero_search_fulltext', { query: `${word} "soil organic"` });
			assert.equal(total, 1);
			assert.equal(results[0].key, attachment.key);
			assert.equal(results[0].parentKey, item.key);
			assert.equal(results[0].title, item.getField('title'));
			assert.equal(results[0].matchCount, 4);
			assert.deepEqual(results[0].passages, [
				{
					page: 2,
					text: `Here Sôil–organic matter and ${word} interact.`,
					link: `zotero://open/library/items/${attachment.key}?page=2`,
				},
				{
					page: 1,
					text: `Introduction about ${word} cycles.`,
					link: `zotero://open/library/items/${attachment.key}?page=1`,
				},
				{
					page: 3,
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
			
			let { files: results } = await call('zotero_search_fulltext', { query: word });
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
			let { files, missing } = await call('zotero_search_fulltext', { query: word, itemKeys: [items[1].key, 'AAAAAAAA'] });
			assert.deepEqual(files.map(file => file.parentKey), [items[1].key]);
			assert.deepEqual(missing, ['AAAAAAAA']);
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
			assert.deepEqual(result.files.map(file => [file.key, file.pending]), [[attachment.key, true]]);
			assert.match(result.notice, /still getting the text of the files with pending/);
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
		
		it("should read a PDF by page, up to about maxChars, with the outline", async function () {
			let item = await createArticle();
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let pages = ['a', 'b', 'c'].map(letter => `${letter} `.repeat(300).trim());
			await setText(attachment, pages);
			stubStructure({
				outline: [{
					title: 'Chapter',
					target: { position: { pageIndex: 1 } },
					children: [{ title: 'Section', target: { position: { pageIndex: 2 } } }],
				}],
			});
			
			// The parent's key reads its PDF
			let result = await call('zotero_read_text', { itemKey: item.key, maxChars: 1000 });
			assert.equal(result.key, attachment.key);
			assert.equal(result.totalPages, 3);
			assert.deepEqual(result.pages, [
				{ page: 1, text: pages[0] },
				{ page: 2, text: pages[1] },
			]);
			assert.equal(result.nextPage, 3);
			assert.deepEqual(result.outline, [
				{ title: 'Chapter', page: 2, children: [{ title: 'Section', page: 3 }] },
			]);
			assert.notProperty(result, 'notice');
			
			result = await call('zotero_read_text', { itemKey: attachment.key, startPage: 3 });
			assert.deepEqual(result.pages, [{ page: 3, text: pages[2] }]);
			assert.notProperty(result, 'nextPage');
			assert.notProperty(result, 'outline');
		});
		
		it("should wait for the outline only until the deadline, and have it later", async function () {
			let attachment = await importFileAttachment('test.pdf');
			await setText(attachment, ['One', 'Two']);
			Zotero.MCP.Tools._structureWait = 200;
			let getReader = sinon.stub(Zotero.SDT, 'getReader');
			let catalog = { outline: [{ title: 'Two', target: { position: { pageIndex: 1 } } }] };
			let generated = Zotero.Promise.delay(1000).then(() => ({ getCatalog: async () => catalog }));
			getReader.returns(generated);
			
			let result = await call('zotero_read_text', { itemKey: attachment.key });
			assert.deepEqual(result.pages, [{ page: 1, text: 'One' }, { page: 2, text: 'Two' }]);
			assert.notProperty(result, 'outline');
			assert.match(result.notice, /outline isn't available yet/);
			assert.isTrue(getReader.calledWith(attachment.id, sinon.match({ isPriority: true })));
			
			// Generation went on, so a later call has the outline
			await generated;
			result = await call('zotero_read_text', { itemKey: attachment.key });
			assert.deepEqual(result.outline, [{ title: 'Two', page: 2 }]);
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
				
				let result = await call('zotero_read_text', { itemKey: attachment.key, startPage: 2, endPage: 3 });
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
			
			let result = await withBudget(300, () => call('zotero_read_text', { itemKey: attachment.key }));
			assert.deepEqual(result.pages, [{ page: 1, text: 'One' }, { page: 2, text: 'Two' }]);
			assert.equal(result.nextPage, 3);
			assert.match(result.notice, /still getting the text/);
			
			extracted.resolve({ text: 'Three\fFour', totalPages: 4 });
			result = await call('zotero_read_text', { itemKey: attachment.key, startPage: 3 });
			assert.deepEqual(result.pages, [{ page: 3, text: 'Three' }, { page: 4, text: 'Four' }]);
			assert.notProperty(result, 'notice');
		});
		
		it("should say when a file's text isn't ready by the deadline", async function () {
			let attachment = await importFileAttachment('stub.epub');
			await IOUtils.remove(Zotero.FullText.getItemCacheFile(attachment).path, { ignoreAbsent: true });
			let indexing = Zotero.Promise.defer();
			sinon.stub(Zotero.FullText, 'indexItems').returns(indexing.promise);
			
			let result = await withBudget(300, () => call('zotero_read_text', { itemKey: attachment.key }));
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
				let result = await call('zotero_read_text', { itemKey: attachment.key, offset, maxChars: 1000 });
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
			assert.match(await callForError('zotero_read_text', { itemKey: note.key }), /isn't a file Zotero can get text from/);
			let item = await createArticle();
			assert.match(await callForError('zotero_read_text', { itemKey: item.key }), /has no PDF/);
		});
	});
	
	describe("zotero_find_fulltext_attachments", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should report what it found for each item, and undo the files it added", async function () {
			let found = await createArticle();
			found.setField('DOI', '10.1234/' + Zotero.Utilities.randomString());
			await found.saveTx();
			let notFound = await createArticle();
			notFound.setField('url', 'https://example.com/' + Zotero.Utilities.randomString());
			await notFound.saveTx();
			let noIdentifier = await createArticle();
			let attachment;
			let usersFile;
			let search = sinon.stub(Zotero.Attachments, 'addAvailableFiles').callsFake(async (items) => {
				assert.sameMembers(items, [found, notFound]);
				attachment = await importFileAttachment('test.pdf', { parentID: found.id });
				// One the user adds meanwhile isn't the search's
				usersFile = await importFileAttachment('test.pdf', { parentID: notFound.id });
				return new Map([[found, attachment], [notFound, false]]);
			});
			
			let { results, notice } = await call('zotero_find_fulltext_attachments', {
				itemKeys: [found.key, notFound.key, noIdentifier.key],
			});
			assert.isTrue(search.calledOnce);
			assert.deepEqual(results.map(result => result.status), ['found', 'notFound', 'skipped']);
			assert.equal(results[0].attachment.key, attachment.key);
			assert.match(results[2].reason, /no DOI, URL or PMCID/);
			assert.match(notice, /zotero_add_attachment/);
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(attachment.deleted);
			assert.isFalse(usersFile.deleted);
		});
		
		it("should say which items it's still searching for at the deadline", async function () {
			let item = await createArticle();
			item.setField('DOI', '10.1234/' + Zotero.Utilities.randomString());
			await item.saveTx();
			sinon.stub(Zotero.Attachments, 'addAvailableFiles').returns(new Promise(() => {}));
			let { results, notice } = await withBudget(300, () => call('zotero_find_fulltext_attachments', { itemKeys: [item.key] }));
			assert.equal(results[0].status, 'pending');
			assert.match(notice, /still looking/);
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
			assert.equal(result.status, 'pending');
			
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
		
		it("should add a file without a parent, identify it in a collection, and undo both", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			let collection = await createDataObject('collection');
			let recognized = new Zotero.Item('journalArticle');
			recognized.setField('title', 'Recognized paper');
			sinon.stub(Zotero.RecognizeDocument, '_recognize').callsFake(async () => {
				await recognized.saveTx();
				return recognized;
			});
			let file = getTestDataDirectory();
			file.append('test.pdf');
			let result = await call('zotero_add_attachment', { path: file.path, collectionKey: collection.key });
			assert.isTrue(result.identified);
			assert.equal(result.parentKey, recognized.key);
			assert.equal(result.parent.title, 'Recognized paper');
			let attachment = Zotero.Items.getByLibraryAndKey(recognized.libraryID, result.key);
			assert.equal(attachment.parentID, recognized.id);
			assert.isTrue(collection.hasItem(recognized));
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(recognized.deleted);
			assert.isTrue(attachment.deleted);
		});
		
		it("should link a file it can't identify as a standalone attachment", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			sinon.stub(Zotero.RecognizeDocument, '_recognize').resolves(false);
			let file = getTestDataDirectory();
			file.append('test.pdf');
			let result = await call('zotero_add_attachment', { path: file.path, linkFile: true });
			assert.isFalse(result.identified);
			assert.equal(result.linkMode, 'linked_file');
			assert.notProperty(result, 'parentKey');
			assert.match(result.notice, /couldn't identify/);
			let attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, result.key);
			assert.isTrue(attachment.isTopLevelItem());
			assert.equal(attachment.getFilePath(), file.path);
			
			assert.match(
				await callForError('zotero_add_attachment', { url: 'https://example.com/a.pdf' }),
				/Give parentKey/
			);
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
			
			await call('zotero_trash', { itemKeys: [item.key] });
			assert.isTrue(ask.calledOnceWith('test-client', Permissions.DELETE, item.libraryID));
			assert.isTrue(item.deleted);
			assert.equal(Zotero.UndoHistory.getUndoAction().action, 'undo-action-mcp-changes');
			
			// Restoring an item restores its trashed children
			note.deleted = true;
			await note.saveTx();
			let { restored } = await call('zotero_trash', { itemKeys: [item.key], restore: true });
			assert.isTrue(restored);
			assert.isTrue(ask.secondCall.calledWith('test-client', Permissions.EDIT_LIBRARY, item.libraryID));
			assert.isFalse(item.deleted);
			assert.isFalse(note.deleted);
			
			let error = await callForError('zotero_trash', { itemKeys: [item.key], restore: true });
			assert.match(error, /isn't in the trash/);
		});
		
		it("should trash and restore a collection with its subcollections, leaving its items", async function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			let parent = await createDataObject('collection');
			let child = await createDataObject('collection', { parentID: parent.id });
			let item = await createArticle({ collections: [child.id] });
			
			let { collectionKeys } = await call('zotero_trash', { collectionKeys: [child.key, parent.key] });
			assert.deepEqual(collectionKeys, [parent.key]);
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
			let error = await callForError('zotero_trash', { itemKeys: [item.key] });
			assert.match(error, /denied/);
			assert.isFalse(item.deleted);
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
			assert.equal(context.tabType, 'library');
			assert.equal(context.libraryID, Zotero.Libraries.userLibraryID);
			assert.deepEqual(context.collections, [{ key: collection.key, name: collection.name }]);
			assert.equal(context.selectedItemCount, 2);
			assert.sameMembers(context.selectedItems.map(item => item.key), [items[0].key, items[2].key]);
			assert.notProperty(context, 'reader');
			let current = context.windows.find(window => window.current);
			assert.equal(current.windowID, win.Zotero_Tabs.windowID);
			assert.deepInclude(current.tabs, {
				tabID: context.tabID,
				type: 'library',
				title: collection.name,
				selected: true,
				libraryID: Zotero.Libraries.userLibraryID,
				collectionKey: collection.key,
			});
		});
		
		it("should return the open file, its page, and the selected text and annotations", async function () {
			let item = await createArticle();
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let annotation = await createAnnotation('highlight', attachment);
			let reader = await Zotero.Reader.open(attachment.id);
			await reader._initPromise;
			let internalReader = reader._internalReader;
			await waitForCallback(() => internalReader.getCurrentPosition());
			let readerWindow = reader._iframeWindow;
			internalReader.setSelectedAnnotations(Cu.cloneInto([annotation.key], readerWindow));
			// As the reader's state has it while text is selected, which getSelection() reads
			internalReader._state.primaryViewSelectionPopup = Cu.cloneInto({
				annotation: {
					text: 'Selected words',
					pageLabel: '1',
					position: { pageIndex: 0, rects: [[1, 1, 2, 2]] },
				},
			}, readerWindow);
			
			let context = await call('zotero_get_context', {});
			assert.equal(context.tabType, 'reader');
			let { selectedAnnotations, ...rest } = context.reader;
			assert.deepEqual(rest, {
				libraryID: attachment.libraryID,
				key: attachment.key,
				parentKey: item.key,
				title: item.getField('title'),
				contentType: 'application/pdf',
				path: attachment.getFilePath(),
				type: 'pdf',
				page: 1,
				link: `zotero://open/library/items/${attachment.key}?page=1`,
				selection: { text: 'Selected words', page: 1 },
			});
			assert.deepEqual(selectedAnnotations.map(annotation => annotation.key), [annotation.key]);
			internalReader._state.primaryViewSelectionPopup = null;
		});
		
		it("should link an EPUB at where the user is", async function () {
			let attachment = await importFileAttachment('recognizeEPUB_test_DOI.epub');
			let reader = await Zotero.Reader.open(attachment.id);
			await reader._initPromise;
			let position = await waitForCallback(() => reader._internalReader.getCurrentPosition());
			
			let context = await call('zotero_get_context', {});
			assert.equal(context.reader.type, 'epub');
			assert.equal(
				context.reader.link,
				`zotero://open/library/items/${attachment.key}?cfi=${encodeURIComponent(position.value)}`
			);
		});
		
		it("should say when the main window isn't open", async function () {
			sinon.stub(Zotero, 'getMainWindow').returns(null);
			assert.deepEqual(await call('zotero_get_context', {}), { window: false, windows: [] });
		});
	});
	
	describe("zotero_select, zotero_open and zotero_close", function () {
		let win;
		
		before(async function () {
			win = await loadZoteroPane();
		});
		
		after(function () {
			for (let other of Zotero.getMainWindows()) {
				if (other != win) {
					other.close();
				}
			}
			win.Zotero_Tabs.closeAll();
			win.close();
		});
		
		it("should select some or all of a collection's items, in this window or a new one", async function () {
			let collection = await createDataObject('collection');
			let items = [];
			for (let i = 0; i < 3; i++) {
				items.push(await createArticle({ collections: [collection.id] }));
			}
			let elsewhere = await createArticle();
			let selectedKeys = view => view.itemsView.getSelectedObjects().map(item => item.key);
			
			let result = await call('zotero_select', {
				collectionKey: collection.key,
				itemKeys: [items[0].key, items[2].key, elsewhere.key],
			});
			assert.equal(result.windowID, win.Zotero_Tabs.windowID);
			assert.equal(result.selectedItemCount, 2);
			assert.deepEqual(result.notShown, [elsewhere.key]);
			let view = win.ZoteroPane.getLibraryView(result.tabID);
			assert.sameMembers(selectedKeys(view), [items[0].key, items[2].key]);
			
			result = await call('zotero_select', { collectionKey: collection.key, allItems: true });
			assert.equal(result.selectedItemCount, 3);
			
			result = await call('zotero_select', { collectionKey: collection.key, itemKeys: [items[1].key], newWindow: true });
			assert.notEqual(result.windowID, win.Zotero_Tabs.windowID);
			let newWin = Zotero.getMainWindows().find(other => other.Zotero_Tabs?.windowID == result.windowID);
			assert.deepEqual(selectedKeys(newWin.ZoteroPane.getLibraryView(result.tabID)), [items[1].key]);
			// The original window keeps its selection
			assert.lengthOf(selectedKeys(view), 3);
			
			
			// Both windows' first library tab is zotero-pane, so it needs a window
			assert.match(
				await callForError('zotero_select', { tabID: 'zotero-pane', itemKeys: [items[0].key] }),
				/zotero-pane is a tab in 2 windows\. Give windowID too/
			);
			assert.match(
				await callForError('zotero_close', { tabIDs: ['zotero-pane'] }),
				/zotero-pane is a tab in 2 windows/
			);
			result = await call('zotero_select', {
				windowID: result.windowID, tabID: 'zotero-pane', collectionKey: collection.key, itemKeys: [items[0].key],
			});
			assert.deepEqual(selectedKeys(newWin.ZoteroPane.getLibraryView('zotero-pane')), [items[0].key]);
			assert.lengthOf(selectedKeys(view), 3);
			
			await call('zotero_close', { windowIDs: [result.windowID] });
			await waitForCallback(() => newWin.closed);
		});
		
		it("should open a PDF at a page, scroll an open one, and close its tabs", async function () {
			let item = await createArticle();
			let attachment = await importFileAttachment('wonderland_short.pdf', { parentID: item.id });
			let pageIndex = (tabID) => {
				let stats = Zotero.Reader.getByTabID(tabID)?._internalReader?._state.primaryViewStats;
				return stats?.pageIndex;
			};
			
			// By its parent item's key
			let opened = await call('zotero_open', { itemKey: item.key, page: 5 });
			assert.equal(opened.key, attachment.key);
			assert.equal(opened.windowID, win.Zotero_Tabs.windowID);
			await waitForCallback(() => pageIndex(opened.tabID) === 4, 50, 20);
			
			// Already open, so its tab scrolls
			let again = await call('zotero_open', { itemKey: attachment.key, page: 2 });
			assert.equal(again.tabID, opened.tabID);
			await waitForCallback(() => pageIndex(opened.tabID) === 1, 50, 20);
			
			let second = await call('zotero_open', { itemKey: attachment.key, newTab: true });
			assert.notEqual(second.tabID, opened.tabID);
			
			let context = await call('zotero_get_context', {});
			let tabs = context.windows.find(window => window.current).tabs
				.filter(tab => tab.key == attachment.key);
			assert.sameMembers(tabs.map(tab => tab.tabID), [opened.tabID, second.tabID]);
			
			let closed = await call('zotero_close', { tabIDs: [opened.tabID, second.tabID] });
			assert.sameMembers(closed.closedTabs, [opened.tabID, second.tabID]);
			assert.lengthOf(win.Zotero_Tabs.getTabIDsByItemID(attachment.id), 0);
		});
		
		it("should open a file in a new window even if a tab in another window has it", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let opened = await call('zotero_open', { itemKey: attachment.key });
			assert.equal(opened.windowID, win.Zotero_Tabs.windowID);
			
			let inWindow = await call('zotero_open', { itemKey: attachment.key, newWindow: true });
			assert.notEqual(inWindow.windowID, win.Zotero_Tabs.windowID);
			let newWin = Zotero.getMainWindows().find(other => other.Zotero_Tabs?.windowID == inWindow.windowID);
			assert.deepEqual(newWin.Zotero_Tabs.getTabIDsByItemID(attachment.id), [inWindow.tabID]);
			assert.equal(newWin.Zotero_Tabs.selectedID, inWindow.tabID);
			// The first tab stays where it was
			assert.deepEqual(win.Zotero_Tabs.getTabIDsByItemID(attachment.id), [opened.tabID]);
			
			await call('zotero_close', { windowIDs: [inWindow.windowID], tabIDs: [opened.tabID] });
			await waitForCallback(() => newWin.closed);
		});
		
		it("should not open what Zotero can't show, or close an unknown tab", async function () {
			let item = await createArticle();
			assert.match(await callForError('zotero_open', { itemKey: item.key }), /has no PDF, EPUB or snapshot/);
			assert.match(await callForError('zotero_close', { tabIDs: ['nope'] }), /No tab nope/);
		});
		
		it("should say when a library tab is still opening at the deadline", async function () {
			sinon.stub(win.ZoteroPane, 'getLibraryView').returns(null);
			let error = await withBudget(300, () => callForError('zotero_select', { allItems: true, newTab: true }));
			assert.match(error, /still opening the library tab/);
			sinon.restore();
			win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
		});
		
		it("should say when a file is still opening at the deadline", async function () {
			let attachment = await importFileAttachment('test.pdf');
			sinon.stub(Zotero.Reader, 'open').resolves();
			let opened = await withBudget(300, () => call('zotero_open', { itemKey: attachment.key }));
			assert.notProperty(opened, 'tabID');
			assert.match(opened.notice, /still opening/);
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
			
			// APA by default, not the style the user copies citations with
			Zotero.Prefs.set('export.quickCopy.setting', 'bibliography=http://www.zotero.org/styles/ieee');
			try {
				result = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'citation' });
				assert.equal(result.style, 'http://www.zotero.org/styles/apa');
				assert.equal(result.output, '(Quuxly, 2020)');
			}
			finally {
				Zotero.Prefs.clear('export.quickCopy.setting');
			}
		});
		
		it("should format a bibliography as text or HTML", async function () {
			let { output } = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'bibliography', style: 'apa' });
			assert.match(output, /^Quuxly, A\. \(2020\)\. A study of things\.$/);
			({ output } = await call('zotero_generate_citation', { items: [{ key: item.key }], format: 'bibliography', style: 'apa', html: true }));
			assert.include(output, 'csl-entry');
		});
		
		it("should format a document's citations together", async function () {
			let other = await createArticle({ title: 'Another study', lastName: 'Quuxly', date: '2020' });
			let third = await createArticle({ title: 'Third study', lastName: 'Zorbin', date: '2019' });
			
			let result = await call('zotero_generate_citation', {
				citations: [[{ key: item.key }], [{ key: other.key, locator: '5' }], [{ key: item.key }, { key: third.key }]],
				format: 'document',
				style: 'apa',
			});
			assert.deepEqual(result.citations, ['(Quuxly, 2020a)', '(Quuxly, 2020b, p. 5)', '(Quuxly, 2020a; Zorbin, 2019)']);
			assert.match(result.bibliography, /^Quuxly, A\. \(2020a\)\. A study of things\.\nQuuxly, A\. \(2020b\)\. Another study\.\nZorbin/);
			assert.isFalse(result.noteStyle);
			
			result = await call('zotero_generate_citation', {
				citations: [[{ key: third.key }], [{ key: item.key }], [{ key: third.key }]],
				format: 'document',
				style: 'ieee',
			});
			assert.deepEqual(result.citations, ['[1]', '[2]', '[1]']);
			assert.match(result.bibliography, /^\[1\][^\n]*Zorbin/);
			
			result = await call('zotero_generate_citation', {
				citations: [[{ key: item.key }], [{ key: item.key }]],
				format: 'document',
				style: 'chicago-notes-bibliography',
			});
			assert.isTrue(result.noteStyle);
			assert.isBelow(result.citations[1].length, result.citations[0].length);
			
			assert.match(
				await callForError('zotero_generate_citation', { items: [{ key: item.key }], format: 'document' }),
				/Give citations for format document/
			);
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
	
	describe("zotero_import", function () {
		beforeEach(function () {
			sinon.stub(Permissions, '_ask').resolves('allow');
			Zotero.UndoHistory.clear();
		});
		
		it("should import text into a collection as one undo step", async function () {
			let collection = await createDataObject('collection');
			let title = Zotero.Utilities.randomString();
			let result = await call('zotero_import', {
				text: `@book{lee2020, title = {${title}}, author = {Lee, Ann}, year = {2020}}`,
				collectionKey: collection.key,
			});
			assert.equal(result.status, 'imported');
			assert.equal(result.collectionKey, collection.key);
			assert.deepEqual(result.items.map(item => [item.itemType, item.title]), [['book', title]]);
			let item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, result.items[0].key);
			assert.isTrue(collection.hasItem(item.id));
			
			assert.isTrue(await Zotero.UndoHistory.undo());
			assert.isTrue(item.deleted);
		});
		
		it("should import a file into a new collection named after it", async function () {
			let path = PathUtils.join(await getTempDirectory(), 'Reading list.ris');
			await IOUtils.copy(getTestDataDirectory().path + '/book_and_child_note.ris', path);
			let result = await call('zotero_import', { path });
			let collection = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, result.collectionKey);
			assert.equal(collection.name, 'Reading list');
			assert.deepEqual(result.items.map(item => item.title), ['Parent']);
			let parent = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, result.items[0].key);
			assert.lengthOf(parent.getNotes(), 1);
		});
		
		it("should not import what isn't in an import format", async function () {
			assert.match(await callForError('zotero_import', { text: 'just some words' }), /isn't in a format/);
			assert.match(await callForError('zotero_import', { path: 'relative.bib' }), /isn't an absolute path/);
		});
	});
	
	describe("zotero_export", function () {
		let item;
		
		before(async function () {
			item = await createArticle({ title: 'A study of things', lastName: 'Quuxly', date: '2020' });
		});
		
		it("should export items as text in a format given by name", async function () {
			let { format, output, citationKeys } = await call('zotero_export', { format: 'bibtex', itemKeys: [item.key] });
			assert.equal(format, 'BibTeX');
			assert.match(output, new RegExp(`^\\s*@article\\{${citationKeys[item.key]},`));
			assert.match(output, /^\s*@article\{/);
			assert.include(output, 'title = {A study of things}');
			
			({ output } = await call('zotero_export', { format: 'CSL JSON', itemKeys: [item.key] }));
			assert.equal(JSON.parse(output)[0].title, 'A study of things');
		});
		
		it("should write a new file, and not replace one", async function () {
			let path = PathUtils.join(await getTempDirectory(), 'export.ris');
			let result = await call('zotero_export', { format: 'RIS', itemKeys: [item.key], path });
			assert.deepEqual(result, { libraryID: Zotero.Libraries.userLibraryID, format: 'RIS', path, status: 'written' });
			assert.include(await Zotero.File.getContentsAsync(path), 'TI  - A study of things');
			
			assert.match(await callForError('zotero_export', { format: 'RIS', itemKeys: [item.key], path }), /already exists/);
			
			result = await call('zotero_export', { format: 'CSL JSON', itemKeys: [item.key], path, overwrite: true });
			assert.equal(result.status, 'written');
			assert.equal(JSON.parse(await Zotero.File.getContentsAsync(path))[0].title, 'A study of things');
			assert.match(
				await callForError('zotero_export', { format: 'RIS', itemKeys: [item.key], path: PathUtils.parent(path), overwrite: true }),
				/only a file can be overwritten/
			);
		});
		
		it("should say when it's still writing a file at the deadline", async function () {
			sinon.stub(Zotero.Translate.Export.prototype, 'translate');
			let path = PathUtils.join(await getTempDirectory(), 'export.ris');
			let result = await withBudget(300, () => call('zotero_export', { format: 'RIS', itemKeys: [item.key], path }));
			assert.equal(result.status, 'pending');
			assert.match(result.notice, /still writing/);
		});
		
		it("should give the citation key of each item in a BibTeX export", async function () {
			let collection = await createDataObject('collection');
			let subcollection = await createDataObject('collection', { parentID: collection.id });
			let first = await createArticle({ title: 'Zeta', lastName: 'Ames', date: '2021' });
			let second = await createArticle({ title: 'Alpha', lastName: 'Ames', date: '2021' });
			let own = await createArticle({ title: 'Own', lastName: 'Bell', date: '2019' });
			own.setField('citationKey', 'bell-own');
			await own.saveTx();
			await Zotero.DB.executeTransaction(async () => {
				for (let each of [first, own]) {
					each.addToCollection(collection.id);
					await each.save();
				}
				second.addToCollection(subcollection.id);
				await second.save();
			});
			await createDataObject('item', { itemType: 'note', collections: [collection.id] });
			
			let { citationKeys } = await call('zotero_export', { format: 'BibTeX', collectionKey: collection.key });
			assert.sameMembers(Object.keys(citationKeys), [first.key, own.key]);
			
			// With subcollections in any format, not only those that keep collections
			let { output: json } = await call('zotero_export', {
				format: 'CSL JSON', collectionKey: collection.key, includeSubcollectionItems: true,
			});
			assert.includeMembers(JSON.parse(json).map(entry => entry.title), ['Zeta', 'Alpha', 'Own']);
			
			let output;
			({ output, citationKeys } = await call('zotero_export', {
				format: 'BibTeX', collectionKey: collection.key, includeSubcollectionItems: true,
			}));
			assert.sameMembers(Object.keys(citationKeys), [first.key, second.key, own.key]);
			assert.equal(citationKeys[own.key], 'bell-own');
			assert.notEqual(citationKeys[first.key], citationKeys[second.key]);
			// Each key heads the entry of its own item
			for (let [itemKey, citationKey] of Object.entries(citationKeys)) {
				let title = Zotero.Items.getByLibraryAndKey(collection.libraryID, itemKey).getField('title');
				assert.match(output, new RegExp(`@article\\{${citationKey},[^@]*title = \\{${title}\\}`));
			}
			
			({ citationKeys } = await call('zotero_export', { format: 'RIS', collectionKey: collection.key }));
			assert.isUndefined(citationKeys);
		});
		
		it("should write a folder with the items' files", async function () {
			let attachment = await importFileAttachment('test.pdf', { parentID: item.id });
			let path = PathUtils.join(await getTempDirectory(), 'With files');
			let result = await call('zotero_export', { format: 'Zotero RDF', itemKeys: [item.key], path, includeFiles: true });
			assert.equal(result.folder, path);
			assert.equal(result.path, PathUtils.join(path, 'With files.rdf'));
			assert.isTrue(await IOUtils.exists(result.path));
			assert.isTrue(await IOUtils.exists(PathUtils.join(path, 'files', String(attachment.id), 'test.pdf')));
			await attachment.eraseTx();
		});
		
		it("should list the formats when it doesn't know one", async function () {
			let error = await callForError('zotero_export', { format: 'nope', itemKeys: [item.key] });
			assert.match(error, /Zotero has no export format nope\. Its formats are .*BibTeX/);
		});
	});
});
