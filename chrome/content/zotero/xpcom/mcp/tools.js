/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
					 https://digitalscholar.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

/*

Handlers for the MCP tools defined in resource://zotero/mcp/tools.json, keyed by tool name in
camelCase without "zotero_", e.g. getItems for zotero_get_items.

Each takes the tool's arguments, already checked against its inputSchema, and a context
({ clientID, signal }), and returns an MCP CallToolResult. Tools with an outputSchema return
Zotero.MCP.jsonResult() of a value matching it. Permissions declared in tools.json are checked
before the handler runs (see mcp.js); a handler that needs one only sometimes asks for it with
Zotero.MCP.Permissions.require(). Throw Zotero.MCP.ToolError for errors the model should see,
such as a key that doesn't exist; other errors are logged and reported to the model by message.

Items are referred to by key, in the library given by the libraryID argument, by default My
Library, as in the Zotero web and local APIs.

*/

Zotero.MCP.Tools = new function () {
	const STYLE_REPOSITORY = 'https://www.zotero.org/styles/';
	const STYLE_ID_PREFIX = 'http://www.zotero.org/styles/';
	
	// Pages zotero_read_text extracts at a time beyond those Zotero indexed
	const EXTRACT_PAGES = 10;
	const LABELS_PENDING = "Page labels (the page numbers printed on the pages) and the outline "
		+ "aren't available yet for some files. Zotero is preparing them, so a later call may "
		+ 'include them.';
	// Characters of context around a zotero_search_fulltext match, and the longest a passage
	// of nearby matches grows
	const PASSAGE_CONTEXT = 200;
	const MAX_PASSAGE = 1000;
	const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
	
	// Most selected items zotero_get_context lists
	const MAX_CONTEXT_ITEMS = 50;
	
	// Zotero.Translate.Export translators for zotero_generate_citation's export formats
	const EXPORT_FORMATS = {
		bibtex: '9cb70025-a888-4a29-a210-93ec52da40d4',
		biblatex: 'b6e39b57-8942-4d11-8259-342c46ce395f',
		ris: '32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7',
		csljson: 'bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7',
	};
	
	// How long a call waits for structured document text (see getStructure())
	this._structureWait = 30 * 1000;
	
	/**
	 * Zotero's version, the libraries, and the permissions the app has been granted
	 */
	this.status = async function (_args, { clientID }) {
		let libraries = Zotero.Libraries.getAll().map(library => ({
			libraryID: library.libraryID,
			type: library.libraryType,
			name: library.name,
			editable: library.editable,
		}));
		return Zotero.MCP.jsonResult({
			zoteroVersion: Zotero.version,
			client: clientID,
			libraries,
			// Reading needs no permission. Other actions ask the user unless granted here.
			permissions: Zotero.MCP.Permissions.getGrants(clientID),
		});
	};
	
	/**
	 * Search like the main window's search box: the same query syntax and modes, in the
	 * library or a collection, with matches in notes, attachments and annotations standing for
	 * the item they belong to
	 */
	this.search = async function ({
		query = '', mode = Zotero.Prefs.get('search.quicksearch-mode'), libraryID, collectionKey,
		sort = 'dateModified', direction, limit = 25, offset = 0,
	}) {
		libraryID = getLibraryID(libraryID);
		
		// The scope, as in Zotero.CollectionTreeRow#getSearchObject()
		let scope = new Zotero.Search();
		scope.libraryID = libraryID;
		scope.addCondition('noChildren', 'true');
		if (collectionKey) {
			let collection = getCollection(libraryID, collectionKey);
			scope.addCondition('collectionID', 'is', collection.id);
			if (Zotero.Prefs.get('recursiveCollections')) {
				scope.addCondition('recursive', 'true');
			}
		}
		let search = new Zotero.Search();
		search.libraryID = libraryID;
		search.setScope(scope, true);
		// A query that names a child type (e.g. "type:note") returns those, not their items
		let childLevel = false;
		query = query.trim();
		if (query) {
			let querySearch = Zotero.SearchQuery.getSearch(query, { libraryID, mode });
			if (querySearch) {
				let level = Object.values(querySearch.getConditions())
					.find(condition => condition.condition == 'resultLevel')?.operator;
				childLevel = level && level != 'item';
				querySearch.setScope(search, true);
				search = querySearch;
			}
			else {
				search.addCondition('quicksearch-' + mode, 'contains', query);
			}
		}
		let items = await Zotero.Items.getAsync(await search.search());
		if (!childLevel) {
			items = Zotero.Items.getTopLevel(items);
		}
		items = items.filter(item => !item.deleted);
		sortItems(items, sort, direction);
		let page = items.slice(offset, offset + limit);
		return Zotero.MCP.jsonResult({
			libraryID,
			total: items.length,
			items: await Promise.all(page.map(summarize)),
			nextOffset: offset + limit < items.length ? offset + limit : undefined,
		});
	};
	
	/**
	 * Items, notes and attachments as Zotero item JSON, with a regular item's attachments and
	 * notes, and an attachment's file
	 */
	this.getItems = async function ({ keys, libraryID }) {
		libraryID = getLibraryID(libraryID);
		let items = [];
		let missing = [];
		for (let key of new Set(keys)) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
			if (!item) {
				missing.push(key);
				continue;
			}
			let json = item.toJSON();
			json.link = getSelectLink(item);
			if (item.isRegularItem()) {
				json.attachments = await Promise.all(
					Zotero.Items.get(item.getAttachments()).map(describeAttachment)
				);
				json.notes = Zotero.Items.get(item.getNotes()).map(note => ({
					key: note.key,
					title: note.getNoteTitle(),
				}));
			}
			else if (item.isFileAttachment()) {
				Object.assign(json, await describeAttachment(item));
			}
			items.push(json);
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			items,
			missing: missing.length ? missing : undefined,
		});
	};
	
	/**
	 * All the library's collections, or all those inside a collection, at every depth
	 */
	this.listCollections = async function ({ libraryID, parentKey }) {
		libraryID = getLibraryID(libraryID);
		let collections;
		if (parentKey) {
			let parent = getCollection(libraryID, parentKey);
			collections = Zotero.Collections.getByParent(parent.id, true);
		}
		else {
			collections = Zotero.Collections.getByLibrary(libraryID, true);
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			collections: collections.map(collection => ({
				key: collection.key,
				name: collection.name,
				parentKey: collection.parentKey || undefined,
				itemCount: collection.getChildItems(true).length,
			})),
		});
	};
	
	/**
	 * Tags in the library, colored tags first (in the tag selector's order), then by how
	 * many items have them
	 */
	this.listTags = async function ({ libraryID, query, limit = 100, offset = 0 }) {
		libraryID = getLibraryID(libraryID);
		let rows = await Zotero.DB.queryAsync(
			'SELECT name, COUNT(DISTINCT itemID) AS count FROM tags '
				+ 'JOIN itemTags USING (tagID) JOIN items USING (itemID) '
				+ 'WHERE libraryID=? AND itemID NOT IN (SELECT itemID FROM deletedItems) '
				+ 'GROUP BY name',
			libraryID
		);
		let counts = new Map(rows.map(row => [row.name, row.count]));
		let colors = Zotero.Tags.getColors(libraryID);
		// Colored tags show in the tag selector even when no item has them
		let names = new Set([...counts.keys(), ...colors.keys()]);
		let tags = [...names].map(name => ({
			name,
			count: counts.get(name) ?? 0,
			color: colors.get(name)?.color,
		}));
		if (query) {
			query = Zotero.Utilities.Internal.normalizeForSearch(query);
			tags = tags.filter(tag => Zotero.Utilities.Internal.normalizeForSearch(tag.name).includes(query));
		}
		let position = name => colors.get(name)?.position ?? Infinity;
		tags.sort((a, b) => position(a.name) - position(b.name)
			|| b.count - a.count
			|| Zotero.localeCompare(a.name, b.name));
		return Zotero.MCP.jsonResult({
			libraryID,
			total: tags.length,
			tags: tags.slice(offset, offset + limit),
			nextOffset: offset + limit < tags.length ? offset + limit : undefined,
		});
	};
	
	/**
	 * Where words or phrases occur in the full text of attachments, with the passage around
	 * each match. Zotero's full-text index only says which attachments match, so the matches
	 * are found again in the text the index was built from.
	 */
	this.searchFulltext = async function ({
		query, keys, collectionKey, libraryID, limit = 10, offset = 0, passagesPerFile = 3,
	}) {
		let deadline = Date.now() + Zotero.MCP.Tools._structureWait;
		let labelsPending = false;
		libraryID = getLibraryID(libraryID);
		let terms = Zotero.SearchConditions.parseSearchString(query)
			.map(part => part.text.trim())
			.filter(Boolean);
		if (!terms.length) {
			throw new Zotero.MCP.ToolError('query has no words to search for');
		}
		// Attachments with every term, as in the search box
		let ids = await getScopeAttachmentIDs(libraryID, { keys, collectionKey });
		for (let term of terms) {
			if (ids && !ids.length) {
				break;
			}
			ids = await Zotero.FullText.findItemsWithContent(term, libraryID, ids);
			if (!ids) {
				throw new Zotero.MCP.ToolError(
					`"${term}" can't be searched for in full text. Search for whole words, or for `
						+ 'two or more Chinese, Japanese or Korean characters.'
				);
			}
		}
		let attachments = (await Zotero.Items.getAsync(ids))
			.filter(item => !item.deleted && !item.parentItem?.deleted);
		// The index doesn't rank matches, so files are listed as zotero_search lists items
		let modified = item => (item.parentItem || item).dateModified;
		attachments.sort((a, b) => (modified(a) < modified(b) ? 1 : modified(a) > modified(b) ? -1 : 0));
		
		let regExps = terms.map(getTermRegExp).filter(Boolean);
		let results = [];
		for (let attachment of attachments.slice(offset, offset + limit)) {
			let text = await getIndexedText(attachment) ?? '';
			let passages = [];
			let matchCount = 0;
			if (attachment.isPDFAttachment()) {
				let structure = await getStructure(attachment, deadline);
				labelsPending ||= !!structure?.pending;
				let labels = structure?.labels;
				// The PDF worker separates pages with form feeds
				text.split('\f').forEach((pageText, i) => {
					let found = findPassages(pageText, regExps);
					matchCount += found.matchCount;
					passages.push(...found.passages.map(passage => ({
						page: i + 1,
						pageLabel: labels?.[i],
						termCount: passage.termCount,
						text: passage.text,
						link: getOpenLink(attachment, { page: i + 1 }),
					})));
				});
			}
			else {
				let found = findPassages(text, regExps);
				matchCount = found.matchCount;
				passages = found.passages.map(passage => ({
					offset: passage.start,
					termCount: passage.termCount,
					text: passage.text,
					link: getOpenLink(attachment),
				}));
			}
			// Passages with more of the terms first, then in document order
			passages.sort((a, b) => b.termCount - a.termCount);
			results.push({
				key: attachment.key,
				parentKey: attachment.parentKey || undefined,
				title: getTitle(attachment),
				contentType: attachment.attachmentContentType,
				matchCount,
				passages: passages.slice(0, passagesPerFile).map(({ termCount: _termCount, ...passage }) => passage),
			});
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			total: attachments.length,
			results,
			nextOffset: offset + limit < attachments.length ? offset + limit : undefined,
			notice: labelsPending ? LABELS_PENDING : undefined,
		});
	};
	
	/**
	 * An attachment's text: a PDF by page, other files by character offset
	 */
	this.readText = async function ({ key, libraryID, startPage, endPage, offset, maxChars = 20000 }) {
		libraryID = getLibraryID(libraryID);
		let attachment = await getTextAttachment(libraryID, key);
		let text = await getIndexedText(attachment);
		let fileExists = await attachment.fileExists();
		if (text === null && !(fileExists && attachment.isPDFAttachment())) {
			throw new Zotero.MCP.ToolError(fileExists
				? `Zotero couldn't get any text from the file of ${attachment.key}`
				: `The file of ${attachment.key} isn't on this computer, and Zotero has no text for it`);
		}
		let result = {
			key: attachment.key,
			parentKey: attachment.parentKey || undefined,
			title: getTitle(attachment),
			contentType: attachment.attachmentContentType,
			link: getOpenLink(attachment),
		};
		
		if (!attachment.isPDFAttachment()) {
			if (startPage || endPage) {
				throw new Zotero.MCP.ToolError(`${attachment.key} has no pages. Read it by offset.`);
			}
			offset ??= 0;
			if (offset > text.length) {
				throw new Zotero.MCP.ToolError(`${attachment.key} has ${text.length} characters`);
			}
			let end = Math.min(text.length, offset + maxChars);
			// End after a line break, or else between words, unless that leaves much less
			if (end < text.length) {
				let cut = [text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1)]
					.find(i => i > offset + maxChars / 2);
				if (cut !== undefined) {
					end = cut + 1;
				}
			}
			let { indexedChars, totalChars } = await Zotero.DB.rowQueryAsync(
				'SELECT indexedChars, totalChars FROM fulltextItems WHERE itemID=?', attachment.id
			) || {};
			Object.assign(result, {
				totalChars: text.length,
				offset,
				text: text.slice(offset, end),
				nextOffset: end < text.length ? end : undefined,
				notice: indexedChars < totalChars
					? `Zotero extracted only the first ${indexedChars} of ${totalChars} characters`
					: undefined,
			});
			return Zotero.MCP.jsonResult(result);
		}
		
		if (offset) {
			throw new Zotero.MCP.ToolError(`${attachment.key} is a PDF. Read it by page.`);
		}
		// The PDF worker separates pages with form feeds. Pages Zotero didn't index are
		// extracted from the file.
		let pages = text === null ? [] : text.split('\f');
		let totalPages = (await Zotero.FullText.getPages(attachment.id))?.total;
		if (!totalPages) {
			let extracted = await extractPages(attachment, [0]);
			totalPages = extracted.totalPages;
			pages[0] = extracted.texts[0];
		}
		startPage ??= 1;
		if (startPage > totalPages) {
			throw new Zotero.MCP.ToolError(`${attachment.key} has ${totalPages} pages`);
		}
		endPage = Math.min(endPage ?? totalPages, totalPages);
		if (endPage < startPage) {
			throw new Zotero.MCP.ToolError('endPage is before startPage');
		}
		let structure = await getStructure(attachment, Date.now() + Zotero.MCP.Tools._structureWait);
		let pageResults = [];
		let chars = 0;
		let page = startPage;
		for (; page <= endPage && (!pageResults.length || chars < maxChars); page++) {
			// Such as pages past the index limit (the fulltext.pdfMaxPages pref), a batch at a time
			if (pages[page - 1] === undefined) {
				let pageIndexes = [];
				for (let i = page - 1; i < Math.min(endPage, page - 1 + EXTRACT_PAGES); i++) {
					pageIndexes.push(i);
				}
				let { texts } = await extractPages(attachment, pageIndexes);
				pageIndexes.forEach((pageIndex, i) => {
					pages[pageIndex] = texts[i] ?? '';
				});
			}
			let pageText = (pages[page - 1] ?? '').trim();
			chars += pageText.length;
			pageResults.push({ page, label: structure?.labels?.[page - 1], text: pageText });
		}
		let notice;
		if (pageResults.every(({ text }) => !text)) {
			notice = 'These pages have no text. If the PDF is scanned, it may need OCR.';
		}
		else if (structure?.pending) {
			notice = LABELS_PENDING;
		}
		Object.assign(result, {
			totalPages,
			pages: pageResults,
			nextPage: page <= endPage ? page : undefined,
			outline: startPage == 1 ? structure?.outline : undefined,
			notice,
		});
		return Zotero.MCP.jsonResult(result);
	};
	
	/**
	 * Notes and annotations, as Markdown or HTML
	 */
	this.getNotes = async function ({ keys, format = 'markdown', libraryID }) {
		libraryID = getLibraryID(libraryID);
		let notes = new Set();
		let annotations = new Set();
		let missing = [];
		for (let key of new Set(keys)) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
			if (!item || item.deleted) {
				missing.push(key);
			}
			else if (item.isNote()) {
				notes.add(item);
			}
			else if (item.isAnnotation()) {
				annotations.add(item);
			}
			else if (item.isRegularItem()) {
				Zotero.Items.get(item.getNotes()).forEach(note => notes.add(note));
				for (let attachment of Zotero.Items.get(item.getAttachments())) {
					if (attachment.isFileAttachment()) {
						attachment.getAnnotations().forEach(annotation => annotations.add(annotation));
					}
				}
			}
			else if (item.isFileAttachment()) {
				item.getAnnotations().forEach(annotation => annotations.add(annotation));
			}
		}
		let noteResults = [];
		for (let note of notes) {
			noteResults.push({
				key: note.key,
				parentKey: note.parentKey || undefined,
				title: note.getNoteTitle(),
				tags: note.getTags().map(tag => tag.tag),
				dateModified: Zotero.Date.sqlToISO8601(note.dateModified),
				content: format == 'html'
					? note.getNote()
					: (await exportItems([note], Zotero.Translators.TRANSLATOR_ID_NOTE_MARKDOWN))
						.replace(/\r\n/g, '\n').trim(),
				link: getSelectLink(note),
			});
		}
		// In the order they're in the file, as in the reader's sidebar
		let annotationResults = [...annotations]
			.sort((a, b) => a.parentID - b.parentID
				|| (a.annotationSortIndex < b.annotationSortIndex ? -1 : 1))
			.map(describeAnnotation);
		return Zotero.MCP.jsonResult({
			libraryID,
			notes: noteResults,
			annotations: annotationResults,
			missing: missing.length ? missing : undefined,
		});
	};
	
	/**
	 * What the user is looking at in the main window: the library tab's selection, and the
	 * open reader or note
	 */
	this.getContext = async function () {
		let win = Zotero.getMainWindow();
		if (!win?.ZoteroPane?.collectionsView) {
			return Zotero.MCP.jsonResult({ window: false });
		}
		let { ZoteroPane, Zotero_Tabs } = win;
		let libraryID = ZoteroPane.getSelectedLibraryIDs()[0];
		let items = ZoteroPane.getSelectedItems(false, { libraryTabOnly: true });
		let result = {
			window: true,
			tab: Zotero_Tabs.selectedType,
			libraryID,
			libraryName: libraryID ? Zotero.Libraries.get(libraryID).name : undefined,
			collections: ZoteroPane.getSelectedCollections().map(collection => ({
				key: collection.key,
				name: collection.name,
			})),
			savedSearches: ZoteroPane.getSelectedSavedSearches().map(search => ({
				key: search.key,
				name: search.name,
			})),
			selectedItemCount: items.length,
			selectedItems: await Promise.all(items.slice(0, MAX_CONTEXT_ITEMS).map(summarize)),
		};
		
		if (Zotero_Tabs.selectedType == 'reader') {
			let reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
			let attachment = reader && Zotero.Items.get(reader.itemID);
			if (attachment) {
				result.reader = describeReader(reader, attachment);
			}
		}
		else if (Zotero_Tabs.selectedType == 'note') {
			let note = Zotero.Items.get(Zotero_Tabs.getTabInfo(Zotero_Tabs.selectedID)?.data.itemID);
			if (note) {
				result.note = {
					libraryID: note.libraryID,
					key: note.key,
					parentKey: note.parentKey || undefined,
					title: note.getNoteTitle(),
					link: getSelectLink(note),
				};
			}
		}
		return Zotero.MCP.jsonResult(result);
	};
	
	/**
	 * Citations and bibliographies in a CSL style, or the items in an export format
	 */
	this.generateCitation = async function ({
		items: refs, format, style, locale, html = false, libraryID,
	}, { clientID, signal }) {
		libraryID = getLibraryID(libraryID);
		let items = [];
		let missing = [];
		for (let ref of refs) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.key);
			if (!item || item.deleted) {
				missing.push(ref.key);
			}
			items.push(item);
		}
		if (missing.length) {
			throw new Zotero.MCP.ToolError(`No items ${missing.join(', ')} in library ${libraryID}`);
		}
		
		if (EXPORT_FORMATS[format]) {
			let output = await exportItems(
				items.filter(item => !item.isAnnotation()),
				EXPORT_FORMATS[format]
			);
			return Zotero.MCP.jsonResult({ format, output: output.trim() });
		}
		
		let notCitable = items.filter(item => !item.isRegularItem());
		if (notCitable.length) {
			throw new Zotero.MCP.ToolError(
				`${notCitable.map(item => item.key).join(', ')} can't be cited: only regular items `
					+ 'can, not notes, attachments or annotations'
			);
		}
		let quickCopy = Zotero.QuickCopy.unserializeSetting(Zotero.Prefs.get('export.quickCopy.setting'));
		style = await getStyle(
			style
				?? (quickCopy.mode == 'bibliography' ? quickCopy.id : Zotero.Prefs.get('export.lastStyle')),
			clientID,
			signal
		);
		locale = locale
			|| (quickCopy.mode == 'bibliography' && quickCopy.locale)
			|| Zotero.Prefs.get('export.quickCopy.locale')
			|| Zotero.locale;
		let outputFormat = html ? 'html' : 'text';
		let engine = style.getCiteProc(locale, outputFormat);
		let output;
		if (format == 'citation') {
			engine.updateItems(items.map(item => item.id));
			let citation = {
				citationItems: items.map((item, i) => ({
					id: item.id,
					locator: refs[i].locator,
					label: refs[i].locator ? (refs[i].label ?? 'page') : undefined,
				})),
				properties: {},
			};
			output = engine.previewCitationCluster(citation, [], [], outputFormat);
		}
		else {
			output = Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, items, outputFormat);
		}
		return Zotero.MCP.jsonResult({
			format,
			style: style.styleID,
			styleTitle: style.title,
			locale: engine.opt.lang,
			output: output.trim(),
		});
	};
	
	/**
	 * Change items' fields, creators, tags and collections, all or none: everything is checked
	 * before anything changes
	 */
	this.updateItems = async function ({ changes, libraryID }, { clientID }) {
		libraryID = getLibraryID(libraryID);
		let checked = [];
		for (let change of changes) {
			let item = await getItem(libraryID, change.key);
			if (!item.isEditable()) {
				throw new Zotero.MCP.ToolError(`${item.key} can't be edited`);
			}
			for (let field of Object.keys(change.fields ?? {})) {
				checkField(item, field);
			}
			if (change.creators) {
				checkCreators(item, change.creators);
			}
			let tags = [...change.addTags ?? [], ...change.removeTags ?? []];
			if (tags.some(tag => !tag.trim())) {
				throw new Zotero.MCP.ToolError('Tags must not be empty');
			}
			let addTo = (change.addToCollections ?? []).map(key => getCollection(libraryID, key));
			let removeFrom = (change.removeFromCollections ?? []).map(key => getCollection(libraryID, key));
			if ((addTo.length || removeFrom.length) && !item.isTopLevelItem()) {
				throw new Zotero.MCP.ToolError(
					`${item.key} is a child item, which is in the collections of its parent item `
						+ `${item.parentKey}`
				);
			}
			checked.push({ item, change, addTo, removeFrom });
		}
		
		let items = [...new Set(checked.map(({ item }) => item))];
		try {
			await edit(clientID, async () => {
				for (let { item, change, addTo, removeFrom } of checked) {
					for (let [field, value] of Object.entries(change.fields ?? {})) {
						item.setField(field, value);
					}
					if (change.creators) {
						item.setCreators(change.creators, { strict: true });
					}
					for (let tag of change.addTags ?? []) {
						item.addTag(tag.trim());
					}
					for (let tag of change.removeTags ?? []) {
						item.removeTag(tag.trim());
					}
					for (let collection of addTo) {
						item.addToCollection(collection.id);
					}
					for (let collection of removeFrom) {
						item.removeFromCollection(collection.id);
					}
					await item.save();
				}
			});
		}
		catch (e) {
			// The transaction was rolled back, but the items still have the changes in memory
			for (let item of items) {
				await item.reload(null, true);
			}
			throw e;
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			items: await Promise.all(items.map(summarize)),
		});
	};
	
	/**
	 * Create, rename or move a collection
	 */
	this.manageCollections = async function ({ action, key, name, parentKey, libraryID }, { clientID }) {
		libraryID = getLibraryID(libraryID);
		name = name?.trim();
		if (action != 'move' && !name) {
			throw new Zotero.MCP.ToolError(`${action} needs a name`);
		}
		if (action == 'move' && parentKey === undefined) {
			throw new Zotero.MCP.ToolError('move needs a parentKey, or null to move to the top level');
		}
		let collection;
		if (action == 'create') {
			collection = new Zotero.Collection({ libraryID });
		}
		else if (key) {
			collection = getCollection(libraryID, key);
		}
		else {
			throw new Zotero.MCP.ToolError(`${action} needs the key of the collection`);
		}
		let parent = parentKey ? getCollection(libraryID, parentKey) : null;
		let result;
		try {
			// Checked and changed inside the transaction, so that concurrent calls can't
			// interleave, e.g. two moves that together put a collection inside itself
			await edit(clientID, async () => {
				if (parent && collection.id
						&& (parent.id == collection.id || collection.hasDescendent('collection', parent.id))) {
					throw new Zotero.MCP.ToolError(`${collection.key} can't be moved into itself or a subcollection`);
				}
				if (action != 'move') {
					collection.name = name;
				}
				if (action != 'rename') {
					collection.parentKey = parent?.key ?? false;
				}
				// New collections aren't selected, so as not to disturb the user
				await collection.save({ skipSelect: true });
				result = {
					libraryID,
					key: collection.key,
					name: collection.name,
					parentKey: collection.parentKey || undefined,
					link: `zotero://select/${Zotero.API.getLibraryPrefix(libraryID)}/collections/${collection.key}`,
				};
			});
		}
		catch (e) {
			// The transaction was rolled back, but the collection still has the changes in memory
			if (collection.id) {
				await collection.reload(null, true);
			}
			throw e;
		}
		return Zotero.MCP.jsonResult(result);
	};
	
	/**
	 * A note from Markdown, under an item, in a collection, or standalone
	 */
	this.addNote = async function ({ markdown, parentKey, collectionKey, libraryID }, { clientID }) {
		libraryID = getLibraryID(libraryID);
		if (!markdown.trim()) {
			throw new Zotero.MCP.ToolError('The note must not be empty');
		}
		if (parentKey && collectionKey) {
			throw new Zotero.MCP.ToolError(
				'Give parentKey or collectionKey, not both: a note under an item shows wherever the item is'
			);
		}
		let note = new Zotero.Item('note');
		note.libraryID = libraryID;
		if (parentKey) {
			let parent = await getItem(libraryID, parentKey);
			if (!parent.isRegularItem()) {
				throw new Zotero.MCP.ToolError(
					`${parent.key} is ${parent.isNote() ? 'a note' : 'an ' + parent.itemType}. Notes can `
						+ "only be added under regular items, such as a journal article."
				);
			}
			note.parentID = parent.id;
		}
		if (collectionKey) {
			note.addToCollection(getCollection(libraryID, collectionKey).id);
		}
		note.setNote(markdownToNoteHTML(markdown));
		// Not selected, so as not to disturb the user
		await edit(clientID, () => note.save({ skipSelect: true }));
		return Zotero.MCP.jsonResult({
			libraryID,
			key: note.key,
			parentKey: note.parentKey || undefined,
			title: note.getNoteTitle(),
			link: getSelectLink(note),
		});
	};
	
	/**
	 * Move items and collections to the trash, or restore them from it
	 *
	 * Trashing needs DELETE, but restoring only EDIT_LIBRARY, so this asks for the permission
	 * itself instead of declaring one in tools.json.
	 */
	this.trash = async function ({
		keys = [], collectionKeys = [], restore = false, libraryID,
	}, { clientID, signal }) {
		libraryID = getLibraryID(libraryID);
		let library = Zotero.Libraries.get(libraryID);
		if (!library.editable || !library.hasTrash) {
			throw new Zotero.MCP.ToolError(`${library.name} is read-only`);
		}
		if (!keys.length && !collectionKeys.length) {
			throw new Zotero.MCP.ToolError('Give keys or collectionKeys');
		}
		let check = (object, type, key) => {
			if (!object) {
				throw new Zotero.MCP.ToolError(`No ${type} ${key} in library ${libraryID}`);
			}
			if (object.deleted != restore) {
				throw new Zotero.MCP.ToolError(
					`${key} ${restore ? "isn't in the trash" : 'is already in the trash'}`
				);
			}
			if (!object.isEditable()) {
				throw new Zotero.MCP.ToolError(`${key} can't be changed`);
			}
			return object;
		};
		let items = [];
		for (let key of new Set(keys)) {
			let item = check(await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key), 'item', key);
			if (item.isAnnotation()) {
				throw new Zotero.MCP.ToolError(`${key} is an annotation, which can't be moved to the trash`);
			}
			items.push(item);
		}
		let collections = [...new Set(collectionKeys)]
			.map(key => check(Zotero.Collections.getByLibraryAndKey(libraryID, key), 'collection', key));
		// Subcollections go with their collection
		collections = collections.filter(collection => !collections.some(
			other => other != collection && other.hasDescendent('collection', collection.id)
		));
		
		let { EDIT_LIBRARY, DELETE } = Zotero.MCP.Permissions;
		await Zotero.MCP.Permissions.require(clientID, restore ? EDIT_LIBRARY : DELETE, libraryID, signal);
		await edit(clientID, async () => {
			if (!restore) {
				await Zotero.Items.trash(items.map(item => item.id));
				for (let collection of collections) {
					collection.deleted = true;
					await collection.save();
				}
				return;
			}
			// As when the user restores only parent items and collections in the trash
			// (ZoteroPane.restoreSelectedItems()), their children come back too
			let restored = [...items, ...collections];
			for (let item of items) {
				if (item.isRegularItem()) {
					restored.push(...Zotero.Items.get([...item.getNotes(true), ...item.getAttachments(true)]));
				}
			}
			for (let collection of collections) {
				restored.push(...Zotero.Collections.get(
					collection.getDescendents(false, 'collection', true).map(descendant => descendant.id)
				));
			}
			for (let object of new Set(restored)) {
				if (object.deleted) {
					object.deleted = false;
					await object.save();
				}
			}
		});
		return Zotero.MCP.jsonResult({
			libraryID,
			restored: restore,
			items: items.map(item => item.key),
			collections: collections.map(collection => collection.key),
		});
	};
	
	/**
	 * An installed style, or one installed from the Zotero Style Repository with the user's
	 * permission
	 *
	 * @param {String} id - A style ID, a short name (e.g. "apa") or a repository URL
	 */
	async function getStyle(id, clientID, signal) {
		if (!Zotero.Styles.initialized()) {
			await Zotero.Styles.init();
		}
		let shortName = id.startsWith(STYLE_ID_PREFIX) || id.startsWith(STYLE_REPOSITORY)
			? id.replace(STYLE_ID_PREFIX, '').replace(STYLE_REPOSITORY, '')
			: id;
		let style = Zotero.Styles.get(id) || Zotero.Styles.get(STYLE_ID_PREFIX + shortName);
		if (style) {
			return style;
		}
		if (!/^[a-z0-9-]+$/.test(shortName)) {
			throw new Zotero.MCP.ToolError(
				`No installed style ${id}. Styles can only be installed from the Zotero Style `
					+ `Repository, by its short name (e.g. "apa") or URL (${STYLE_REPOSITORY}apa).`
			);
		}
		// Fetched before asking, so a style that doesn't exist doesn't cost the user a prompt
		let url = STYLE_REPOSITORY + shortName;
		let xml;
		try {
			xml = (await Zotero.HTTP.request('GET', url, { responseType: 'text' })).response;
		}
		catch (e) {
			if (e instanceof Zotero.HTTP.UnexpectedStatusException && e.status == 404) {
				throw new Zotero.MCP.ToolError(
					`No style "${shortName}" in the Zotero Style Repository. Find style names at `
						+ STYLE_REPOSITORY
				);
			}
			throw e;
		}
		await Zotero.MCP.Permissions.require(clientID, Zotero.MCP.Permissions.INSTALL_STYLES, null, signal);
		let { styleID } = await Zotero.Styles.install({ string: xml }, url, true);
		return Zotero.Styles.get(styleID);
	}
	
	function exportItems(items, translatorID) {
		return new Promise((resolve, reject) => {
			let translation = new Zotero.Translate.Export();
			translation.setItems(items);
			translation.setTranslator(translatorID);
			translation.setHandler('done', () => resolve(translation.string));
			translation.setHandler('error', (_, error) => reject(error));
			translation.translate();
		});
	}
	
	/**
	 * The attachments of the items given by keys or in a collection, or null for the whole
	 * library
	 */
	async function getScopeAttachmentIDs(libraryID, { keys, collectionKey }) {
		if (keys && collectionKey) {
			throw new Zotero.MCP.ToolError('Give keys or collectionKey, not both');
		}
		let items = [];
		if (keys) {
			for (let key of keys) {
				let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
				if (!item || item.deleted) {
					throw new Zotero.MCP.ToolError(`No item ${key} in library ${libraryID}`);
				}
				items.push(item);
			}
		}
		else if (collectionKey) {
			let collection = getCollection(libraryID, collectionKey);
			let collections = [collection];
			if (Zotero.Prefs.get('recursiveCollections')) {
				collections.push(...Zotero.Collections.get(
					collection.getDescendents(false, 'collection').map(descendant => descendant.id)
				));
			}
			for (let collection of collections) {
				items.push(...collection.getChildItems());
			}
		}
		else {
			return null;
		}
		let ids = new Set();
		for (let item of items) {
			if (item.isRegularItem()) {
				item.getAttachments().forEach(id => ids.add(id));
			}
			else if (item.isAttachment()) {
				ids.add(item.id);
			}
		}
		return [...ids];
	}
	
	/**
	 * A file attachment Zotero can get text from, or the best one of a parent item
	 */
	async function getTextAttachment(libraryID, key) {
		let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
		if (!item || item.deleted) {
			throw new Zotero.MCP.ToolError(`No item ${key} in library ${libraryID}`);
		}
		if (item.isRegularItem()) {
			item = await item.getBestAttachment();
			if (!item) {
				throw new Zotero.MCP.ToolError(`${key} has no PDF, EPUB, snapshot or other file`);
			}
		}
		if (!Zotero.FullText.canIndex(item)) {
			throw new Zotero.MCP.ToolError(
				`${item.key} isn't a file Zotero can get text from: only PDFs, EPUBs, web page `
					+ 'snapshots and text files'
			);
		}
		return item;
	}
	
	/**
	 * The text Zotero extracted from an attachment for its full-text index (indexing it now if
	 * it hasn't been), or a text file's contents
	 *
	 * @return {Promise<String|null>} Null if there's no text, or the file is missing
	 */
	async function getIndexedText(attachment) {
		if (!Zotero.FullText.isCachedMIMEType(attachment.attachmentContentType)) {
			let path = await attachment.getFilePathAsync();
			return path ? Zotero.File.getContentsAsync(path, attachment.attachmentCharset) : null;
		}
		let path = Zotero.FullText.getItemCacheFile(attachment).path;
		if (!await IOUtils.exists(path) && await attachment.fileExists()) {
			await Zotero.FullText.indexItems([attachment.id]);
		}
		return await IOUtils.exists(path) ? Zotero.File.getContentsAsync(path) : null;
	}
	
	/**
	 * Text of PDF pages, from the file
	 *
	 * @param {Integer[]} pageIndexes - Consecutive
	 * @return {Promise<Object>} { texts, totalPages }, with texts in the order of pageIndexes
	 */
	async function extractPages(attachment, pageIndexes) {
		let { text, totalPages } = await Zotero.PDFWorker.getFullText(attachment.id, pageIndexes, true);
		return { texts: text.split('\f'), totalPages };
	}
	
	/**
	 * A PDF's page labels (the page numbers printed on its pages) and outline, from its
	 * structured document text (see sdt.js)
	 *
	 * The text itself comes from the full-text index, which works even when only text synced
	 * from another computer is here; structured document text is only for what the index
	 * doesn't have. Like Read Aloud, it's generated if it isn't cached, at the front of the PDF
	 * worker's queue. That takes about 25 ms a page, but the worker runs one job at a time,
	 * and an MCP call can't take long (zotero-mcp-stdio gives up after 50 seconds), so it's
	 * waited for only until the deadline. Generation goes on after that, so a later call has it.
	 *
	 * @param {Number} deadline - Date.now() time to stop waiting at
	 * @return {Promise<Object|null>} { labels, outline }, { pending: true } if it wasn't ready
	 *     by the deadline, or null if there's none (e.g., a password-protected PDF)
	 */
	async function getStructure(attachment, deadline) {
		let reader = Zotero.SDT.getReader(attachment.id, { isPriority: true });
		let timeout = Zotero.Promise.delay(Math.max(0, deadline - Date.now())).then(() => 'timeout');
		let result = await Promise.race([reader, timeout]);
		if (result == 'timeout') {
			// getPack() logs its own errors
			reader.catch(() => {});
			return { pending: true };
		}
		if (!result) {
			return null;
		}
		let { pages = [], outline = [] } = await result.getCatalog();
		let getOutline = entries => entries.map((entry) => {
			let pageIndex = entry.target?.position?.pageIndex;
			return {
				title: entry.title,
				page: Number.isInteger(pageIndex) ? pageIndex + 1 : undefined,
				children: entry.children?.length ? getOutline(entry.children) : undefined,
			};
		});
		return {
			labels: pages.map(page => page.label),
			outline: getOutline(outline),
		};
	}
	
	/**
	 * A RegExp for a search term in text normalized with normalizeWithOffsets(), matching as
	 * Zotero.FullText.findItemsWithContent() does: ignoring case and diacritics, with any
	 * whitespace and hyphens between words, from the start of a word except in CJK text
	 */
	function getTermRegExp(term) {
		let pattern = Zotero.Utilities.Internal.normalizeForSearch(term)
			.split(/[\s-]+/)
			.filter(Boolean)
			.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('[\\s-]+');
		if (!pattern) {
			return null;
		}
		if (/^[\p{L}\p{N}]/u.test(pattern) && !CJK_RE.test(pattern)) {
			pattern = '(?<![\\p{L}\\p{N}])' + pattern;
		}
		return new RegExp(pattern, 'gu');
	}
	
	/**
	 * Text normalized with normalizeForSearch(), and for each character of it, the offset in
	 * the text of the character it came from, so a match can be cut from the original text
	 */
	function normalizeWithOffsets(text) {
		let pieces = [];
		let offsets = [];
		let offset = 0;
		for (let char of text) {
			let piece = char.charCodeAt(0) < 0x80
				? char.toLowerCase()
				: Zotero.Utilities.Internal.normalizeForSearch(char);
			pieces.push(piece);
			for (let i = 0; i < piece.length; i++) {
				offsets.push(offset);
			}
			offset += char.length;
		}
		offsets.push(offset);
		return { normalized: pieces.join(''), offsets };
	}
	
	/**
	 * Passages of text around matches of the RegExps, with nearby matches in one passage
	 *
	 * @return {Object} { matchCount, passages: [{ start, text, termCount }] }, termCount being
	 *     how many of the RegExps match in the passage
	 */
	function findPassages(text, regExps) {
		let { normalized, offsets } = normalizeWithOffsets(text);
		let matches = [];
		regExps.forEach((regExp, term) => {
			for (let match of normalized.matchAll(regExp)) {
				matches.push({
					term,
					start: offsets[match.index],
					end: offsets[match.index + match[0].length],
				});
			}
		});
		matches.sort((a, b) => a.start - b.start);
		let ranges = [];
		for (let match of matches) {
			let start = Math.max(0, match.start - PASSAGE_CONTEXT);
			let end = Math.min(text.length, match.end + PASSAGE_CONTEXT);
			let last = ranges.at(-1);
			if (last && start <= last.end && end - last.start <= MAX_PASSAGE) {
				last.end = end;
				last.terms.add(match.term);
			}
			else {
				ranges.push({ start, end, terms: new Set([match.term]) });
			}
		}
		let passages = ranges.map(({ start, end, terms }) => {
			let passage = text.slice(start, end);
			// Start and end between words
			if (start > 0) {
				let cut = passage.match(/^\S*\s+/)?.[0].length ?? 0;
				passage = passage.slice(cut);
				start += cut;
			}
			if (end < text.length) {
				passage = passage.replace(/\s+\S*$/, '');
			}
			return {
				start,
				text: (start > 0 ? '…' : '') + passage.replace(/\s+/g, ' ').trim()
					+ (end < text.length ? '…' : ''),
				termCount: terms.size,
			};
		});
		return { matchCount: matches.length, passages };
	}
	
	/**
	 * For an attachment, its parent's title
	 */
	function getTitle(attachment) {
		return attachment.parentItem?.getDisplayTitle() || attachment.getField('title');
	}
	
	/**
	 * The file open in a reader tab, the page the user is on, and what they've selected
	 */
	function describeReader(reader, attachment) {
		let { pageIndex, pageLabel, selection, selectedAnnotationKeys } = getReaderState(reader);
		let page;
		// For an EPUB, the reader's page is a location number unless the book has page numbers,
		// and links can't open one, so only a selection's page label is given
		if (attachment.isPDFAttachment()) {
			pageIndex ??= attachment.getAttachmentLastPageIndex() ?? undefined;
			page = Number.isInteger(pageIndex) ? pageIndex + 1 : undefined;
		}
		else {
			pageLabel = undefined;
		}
		let description = {
			libraryID: attachment.libraryID,
			key: attachment.key,
			parentKey: attachment.parentKey || undefined,
			title: getTitle(attachment),
			contentType: attachment.attachmentContentType,
			type: reader.type,
			page,
			pageLabel: knownPageLabel(pageLabel),
			link: getOpenLink(attachment, { page }),
			selectedAnnotations: selectedAnnotationKeys
				.map(key => Zotero.Items.getByLibraryAndKey(attachment.libraryID, key))
				.filter(annotation => annotation?.isAnnotation())
				.map(describeAnnotation),
		};
		if (selection?.text) {
			let selectionPageIndex = selection.position?.pageIndex;
			description.selection = {
				text: selection.text,
				page: Number.isInteger(selectionPageIndex) ? selectionPageIndex + 1 : undefined,
				pageLabel: knownPageLabel(selection.pageLabel),
			};
		}
		return description;
	}
	
	/**
	 * The page the user is on and what they've selected, from the reader's private state,
	 * which can change without notice, so anything missing is left out.
	 *
	 * TODO: Use _internalReader.getSelection(), .selectedAnnotationIDs, .pageIndex and
	 * .pageLabel once the reader has them (https://github.com/zotero/reader/pull/276)
	 */
	function getReaderState(reader) {
		try {
			let internalReader = reader._internalReader;
			let state = internalReader._state;
			// The view the user last used, as the reader's getSelectionPosition() decides
			let view = internalReader._lastViewPrimary === false ? 'secondaryView' : 'primaryView';
			// Copied out of the reader's window, so they can be passed on
			let copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
			let stats = copy(state[`${view}Stats`]) || {};
			let selectedAnnotationKeys = copy(state.selectedAnnotationIDs);
			return {
				pageIndex: Number.isInteger(stats.pageIndex) ? stats.pageIndex : undefined,
				pageLabel: typeof stats.pageLabel == 'string' ? stats.pageLabel : undefined,
				selection: copy(state[`${view}SelectionPopup`]?.annotation),
				selectedAnnotationKeys: Array.isArray(selectedAnnotationKeys) ? selectedAnnotationKeys : [],
			};
		}
		catch (e) {
			Zotero.logError(e);
			return { selectedAnnotationKeys: [] };
		}
	}
	
	/**
	 * A page label, without the reader's "-" for a page whose label it couldn't determine
	 */
	function knownPageLabel(label) {
		return label && label != '-' ? label : undefined;
	}
	
	function describeAnnotation(annotation) {
		let attachment = annotation.parentItem;
		let pageIndex = attachment.isPDFAttachment()
			? JSON.parse(annotation.annotationPosition).pageIndex
			: undefined;
		return {
			key: annotation.key,
			attachmentKey: attachment.key,
			type: annotation.annotationType,
			text: annotation.annotationText || undefined,
			comment: annotation.annotationComment || undefined,
			color: annotation.annotationColor,
			page: Number.isInteger(pageIndex) ? pageIndex + 1 : undefined,
			pageLabel: knownPageLabel(annotation.annotationPageLabel),
			tags: annotation.getTags().map(tag => tag.tag),
			link: getOpenLink(attachment, { annotation: annotation.key }),
		};
	}
	
	function getLibraryID(libraryID = Zotero.Libraries.userLibraryID) {
		if (!Zotero.Libraries.exists(libraryID)) {
			throw new Zotero.MCP.ToolError(`No library ${libraryID}. zotero_status lists the libraries.`);
		}
		return libraryID;
	}
	
	function getCollection(libraryID, key) {
		let collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
		if (!collection || collection.deleted) {
			throw new Zotero.MCP.ToolError(`No collection ${key} in library ${libraryID}`);
		}
		return collection;
	}
	
	/**
	 * A link that selects the item in Zotero, for the AI app to show the user
	 */
	function getSelectLink(item) {
		return `zotero://select/${Zotero.API.getLibraryPrefix(item.libraryID)}/items/${item.key}`;
	}
	
	/**
	 * A link that opens an attachment in Zotero, at a PDF page (1-based) or an annotation
	 */
	function getOpenLink(attachment, { page, annotation } = {}) {
		let link = `zotero://open/${Zotero.API.getLibraryPrefix(attachment.libraryID)}/items/${attachment.key}`;
		if (annotation) {
			return `${link}?annotation=${annotation}`;
		}
		if (page) {
			return `${link}?page=${page}`;
		}
		return link;
	}
	
	/**
	 * An item as a search result
	 */
	async function summarize(item) {
		let summary = {
			key: item.key,
			itemType: item.itemType,
			parentKey: item.parentKey || undefined,
			link: getSelectLink(item),
		};
		if (item.isAnnotation()) {
			summary.title = Zotero.Utilities.ellipsize(item.annotationText || item.annotationComment || '', 200);
			return summary;
		}
		summary.title = item.getDisplayTitle();
		if (item.isRegularItem()) {
			summary.creators = item.getField('firstCreator') || undefined;
			summary.date = item.getField('date', false, true) || undefined;
			summary.citationKey = item.getField('citationKey') || undefined;
			let attachment = await item.getBestAttachment();
			if (attachment) {
				summary.file = { key: attachment.key, contentType: attachment.attachmentContentType };
			}
		}
		return summary;
	}
	
	async function describeAttachment(attachment) {
		let description = {
			key: attachment.key,
			title: attachment.getField('title'),
			contentType: attachment.attachmentContentType || undefined,
			linkMode: Zotero.Attachments.linkModeToName(attachment.attachmentLinkMode),
		};
		if (attachment.isFileAttachment()) {
			description.fileExists = await attachment.fileExists();
			description.annotationCount = attachment.getAnnotations().length;
		}
		return description;
	}
	
	function sortItems(items, sort, direction) {
		let value = {
			dateModified: item => item.dateModified,
			dateAdded: item => item.dateAdded,
			title: item => item.getDisplayTitle(),
			creator: item => (item.isRegularItem() ? item.getField('firstCreator') : ''),
			// Multipart dates ("2020-05-00 May 2020") sort by their first part
			date: item => (item.isRegularItem() ? item.getField('date', true, true).slice(0, 10) : ''),
		}[sort];
		let compare = sort == 'title' || sort == 'creator'
			? (a, b) => Zotero.localeCompare(a, b)
			: (a, b) => (a < b ? -1 : a > b ? 1 : 0);
		// Newest first for dates, A to Z otherwise
		let sign = (direction ?? (sort.startsWith('date') ? 'desc' : 'asc')) == 'desc' ? -1 : 1;
		let values = new Map(items.map(item => [item, value(item)]));
		items.sort((a, b) => sign * compare(values.get(a), values.get(b)));
	}
	
	/**
	 * Run an app's changes in one transaction, which the user undoes in one step (Edit → Undo
	 * Changes by <app>). Undo moves new items and collections to the trash.
	 */
	function edit(clientID, fn) {
		return Zotero.DB.executeTransaction(async () => {
			let result = await fn();
			// After fn(), as the last label staged wins over e.g. Zotero.Items.trash()'s own
			Zotero.UndoHistory.stageAction('undo-action-mcp-changes', {
				app: Zotero.MCP.Apps.getDisplayName(clientID)
			});
			return result;
		});
	}
	
	async function getItem(libraryID, key) {
		let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
		if (!item || item.deleted) {
			throw new Zotero.MCP.ToolError(`No item ${key} in library ${libraryID}`);
		}
		return item;
	}
	
	/**
	 * @throws {Zotero.MCP.ToolError} If a field isn't valid for the item's type
	 */
	function checkField(item, field) {
		let fieldID = Zotero.ItemFields.getID(field);
		// Base fields (e.g. publicationTitle) stand for the type's own (e.g. bookTitle)
		fieldID = fieldID && (Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, fieldID) || fieldID);
		if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
			let fields = Zotero.ItemFields.getItemTypeFields(item.itemTypeID)
				.map(id => Zotero.ItemFields.getName(id));
			throw new Zotero.MCP.ToolError(
				`${item.key}: ${field} isn't a field of item type ${item.itemType}. `
					+ (fields.length ? `Its fields are ${fields.join(', ')}.` : 'It has no fields.')
			);
		}
	}
	
	/**
	 * @throws {Zotero.MCP.ToolError} If a creator type isn't valid for the item's type
	 */
	function checkCreators(item, creators) {
		let types = Zotero.CreatorTypes.getTypesForItemType(item.itemTypeID).map(type => type.name);
		for (let creator of creators) {
			if (!types.includes(creator.creatorType)) {
				throw new Zotero.MCP.ToolError(
					`${item.key}: ${creator.creatorType} isn't a creator type of item type ${item.itemType}. `
						+ (types.length ? `Its creator types are ${types.join(', ')}.` : 'It has no creators.')
				);
			}
		}
	}
	
	let _markdownIt;
	
	/**
	 * Note HTML from Markdown, as the note editor makes from pasted Markdown (CommonMark with
	 * tables, strikethrough and TeX math, and no raw HTML), and with bare URLs made links
	 */
	function markdownToNoteHTML(markdown) {
		if (!_markdownIt) {
			// The note editor's configuration (note-editor/src/core/plugins/markdown-parser.js),
			// plus the linkify rule, which the commonmark preset leaves off even with
			// linkify: true
			_markdownIt = require('markdown-it')('commonmark', { html: false, linkify: true, breaks: false })
				.enable(['table', 'strikethrough', 'linkify']);
			addMath(_markdownIt);
			// Notes only show images stored in Zotero, so other images become links
			_markdownIt.renderer.rules.image = (tokens, i, options, env, self) => {
				let src = _markdownIt.utils.escapeHtml(tokens[i].attrGet('src'));
				let alt = self.renderInlineAsText(tokens[i].children, options, env);
				return `<a href="${src}">${_markdownIt.utils.escapeHtml(alt) || src}</a>`;
			};
		}
		return `<div data-schema-version="9">${_markdownIt.render(markdown)}</div>`;
	}
	
	/**
	 * TeX math as the note editor stores it: <span class="math">$…$</span> and
	 * <pre class="math">$$…$$</pre>
	 *
	 * The same rules as when Markdown is pasted into a note, copied from the note editor
	 * (note-editor/src/core/plugins/markdown-parser.js), so a note reads the same either way:
	 * dollar signs become math only around content that looks like math (a TeX command,
	 * braces or an operator), and display math is fenced by lines of just $$.
	 */
	function addMath(md) {
		let { escapeHtml } = md.utils;
		
		function isMathish(content) {
			let text = String(content).trim();
			if (!text) return false;
			// Ignore trivial numeric values (helps with currency like "$20")
			if (/^\d+(?:[.,]\d+)?$/.test(text)) return false;
			let hasCommand = /\\[a-zA-Z]+/.test(text);
			// Leading +/- of a number isn't an operator
			let sanitized = text.replace(/(^|\s)[+-](?=\d)/g, ' ');
			let hasOperator = /[+\-*/=^_]/.test(sanitized);
			let open = (text.match(/{/g) || []).length;
			let close = (text.match(/}/g) || []).length;
			if ((open || close) && open !== close) return false;
			return hasCommand || open > 0 || hasOperator;
		}
		
		md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
			let start = state.pos;
			if (state.src[start] !== '$' || state.src[start + 1] === '$') return false;
			// Avoid matching inside code spans
			if (state.tokens && state.tokens.some(t => t.type === 'code_inline')) return false;
			let pos = start + 1;
			let found = false;
			while (pos < state.posMax) {
				if (state.src[pos] === '$') {
					// An odd number of backslashes escapes it
					let backslashes = 0;
					for (let prev = pos - 1; prev >= 0 && state.src[prev] === '\\'; prev--) {
						backslashes++;
					}
					if (backslashes % 2 === 0) {
						found = true;
						break;
					}
				}
				pos++;
			}
			if (!found) return false;
			let content = state.src.slice(start + 1, pos);
			if (!content || /^\s+$/.test(content) || !isMathish(content)) return false;
			if (!silent) {
				state.push('math_inline', '', 0).content = content;
			}
			state.pos = pos + 1;
			return true;
		});
		
		md.block.ruler.after('fence', 'math_block', (state, startLine, endLine, silent) => {
			// A line of $$ and nothing else but spaces and tabs
			let isFence = (line) => {
				let start = state.bMarks[line] + state.tShift[line];
				return /^\$\$[ \t]*$/.test(state.src.slice(start, state.eMarks[line]));
			};
			if (!isFence(startLine)) return false;
			let contentStart = state.bMarks[startLine] + state.tShift[startLine] + 2;
			let nextLine = startLine;
			let contentEnd;
			while (true) {
				nextLine++;
				if (nextLine >= endLine) return false;
				if (isFence(nextLine)) {
					contentEnd = state.bMarks[nextLine];
					break;
				}
			}
			if (silent) return true;
			let content = state.src.slice(contentStart, contentEnd).replace(/^\s*\n?|\n?\s*$/g, '');
			if (!isMathish(content)) return false;
			state.line = nextLine + 1;
			let token = state.push('math_block', '', 0);
			token.block = true;
			token.map = [startLine, nextLine + 1];
			token.content = content;
			return true;
		});
		
		// eslint-disable-next-line camelcase
		md.renderer.rules.math_inline = (tokens, i) => `<span class="math">$${escapeHtml(tokens[i].content)}$</span>`;
		// eslint-disable-next-line camelcase
		md.renderer.rules.math_block = (tokens, i) => `<pre class="math">$$${escapeHtml(tokens[i].content)}$$</pre>\n`;
	}
};
