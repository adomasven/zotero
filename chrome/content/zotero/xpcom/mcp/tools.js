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

Each takes the tool's arguments, already checked against its inputSchema, and the call's
context ({ clientID, signal, deadline }), and returns an MCP CallToolResult by the deadline (see
Zotero.MCP.CALL_BUDGET): waits for slow work end then, and the work can go on in the
background. Tools with an outputSchema return Zotero.MCP.jsonResult() of a value matching it.
Permissions declared in tools.json are checked before the handler runs (see mcp.js); a handler
that needs one only sometimes asks for it with Zotero.MCP.Permissions.require(). Throw
Zotero.MCP.ToolError for errors the model should see, such as a key that doesn't exist; other
errors are logged and reported to the model by message.

Items are referred to by key, in the library given by the libraryID argument, by default My
Library, as in the Zotero web and local APIs.

*/

Zotero.MCP.Tools = new function () {
	const STYLE_REPOSITORY = 'https://www.zotero.org/styles/';
	const STYLE_ID_PREFIX = 'http://www.zotero.org/styles/';
	
	// Pages zotero_read_text extracts at a time beyond those Zotero indexed
	const EXTRACT_PAGES = 10;
	// What untilDeadline() gives when the deadline comes first
	const TIMED_OUT = Symbol('timedOut');
	const TEXT_PENDING = "Zotero is still getting the text from the file, so it isn't all here. "
		+ 'Call zotero_read_text again shortly, from nextPage for a PDF.';
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
	
	// Most new items zotero_import lists
	const MAX_LISTED_ITEMS = 50;
	// Longest export zotero_export returns as text, in characters
	const MAX_EXPORT_CHARS = 200000;
	// Annotations Zotero keeps an image of
	const IMAGE_ANNOTATION_TYPES = ['image', 'ink'];
	// Most items zotero_export gives the BibTeX citation keys of
	const MAX_CITATION_KEYS = 500;
	const BIBTEX_TRANSLATOR_ID = '9cb70025-a888-4a29-a210-93ec52da40d4';
	const BIBLATEX_TRANSLATOR_ID = 'b6e39b57-8942-4d11-8259-342c46ce395f';
	const LAST_RESORT = 'As a last resort, ask the user to save it with the Zotero Connector from a '
		+ "browser where they're signed in to the site.";
	const FILES_NOT_FOUND = "Zotero found no PDF or EPUB for items with fileSearch notFound. Find "
		+ "one elsewhere (e.g. arXiv, PubMed Central or the author's site) and attach it with "
		+ 'zotero_add_attachment. ' + LAST_RESORT;
	const FILES_PENDING = 'Zotero is still looking for files for items with fileSearch searching. '
		+ 'Call zotero_get_items later to see what it found.';
	const LOOKUPS_PENDING = 'Zotero is still looking up the identifiers with status inProgress. It '
		+ 'adds each item when its lookup finishes, and looks for its file if asked to. To get their '
		+ 'keys, search for them later with zotero_search in fields mode, by the identifier. If one '
		+ "doesn't turn up, Zotero couldn't find it: give its metadata as items.";
	// Identifiers zotero_add_items looks up at a time
	const LOOKUP_CONCURRENCY = 3;
	// Properties of item JSON from Zotero (e.g. zotero_get_items) that a new item doesn't take
	const EXISTING_ITEM_PROPERTIES = new Set([
		'key',
		'version',
		'parentItem',
		'collections',
		'relations',
		'deleted',
		'inPublications',
		'dateAdded',
		'dateModified',
		'link',
		'attachments',
		'notes',
	]);
	
	// Longest a call waits for structured document text (see getStructure()), within its
	// deadline
	this._structureWait = 15 * 1000;
	
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
	this.getItems = async function ({ keys, includeTrashed = false, libraryID }) {
		libraryID = getLibraryID(libraryID);
		let items = [];
		let missing = [];
		for (let key of new Set(keys)) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
			if (!item || item.deleted && !includeTrashed) {
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
	 * Saved searches, with their conditions and how many items each finds
	 */
	this.listSavedSearches = async function ({ libraryID }) {
		libraryID = getLibraryID(libraryID);
		let searches = Zotero.Searches.getByLibrary(libraryID).filter(search => !search.deleted);
		return Zotero.MCP.jsonResult({
			libraryID,
			savedSearches: await Promise.all(searches.map(async search => ({
				key: search.key,
				name: search.name,
				conditions: search.toJSON().conditions,
				itemCount: await countSearchItems(search),
				link: `zotero://select/${Zotero.API.getLibraryPrefix(libraryID)}/searches/${search.key}`,
			}))),
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
	}, { deadline }) {
		let structureDeadline = Math.min(deadline, Date.now() + Zotero.MCP.Tools._structureWait);
		let labelsPending = false;
		let textPending = false;
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
			let text = await getIndexedText(attachment, deadline);
			let summary = {
				key: attachment.key,
				parentKey: attachment.parentKey || undefined,
				title: getTitle(attachment),
				contentType: attachment.attachmentContentType,
			};
			if (text === TIMED_OUT) {
				textPending = true;
				results.push({ ...summary, textPending: true, passages: [] });
				continue;
			}
			text ??= '';
			let passages = [];
			let matchCount = 0;
			if (attachment.isPDFAttachment()) {
				let structure = await getStructure(attachment, structureDeadline);
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
				...summary,
				matchCount,
				passages: passages.slice(0, passagesPerFile).map(({ termCount: _termCount, ...passage }) => passage),
			});
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			total: attachments.length,
			results,
			nextOffset: offset + limit < attachments.length ? offset + limit : undefined,
			notice: [
				textPending && 'Zotero is still getting the text of the files with textPending, so their '
					+ 'passages are missing. Search again shortly.',
				labelsPending && LABELS_PENDING,
			].filter(Boolean).join(' ') || undefined,
		});
	};
	
	/**
	 * An attachment's text: a PDF by page, other files by character offset
	 */
	this.readText = async function ({
		key, libraryID, startPage, endPage, offset, maxChars = 20000,
	}, { deadline }) {
		libraryID = getLibraryID(libraryID);
		let attachment = await getTextAttachment(libraryID, key);
		let text = await getIndexedText(attachment, deadline);
		let fileExists = await attachment.fileExists();
		let result = {
			libraryID,
			key: attachment.key,
			parentKey: attachment.parentKey || undefined,
			title: getTitle(attachment),
			contentType: attachment.attachmentContentType,
			link: getOpenLink(attachment),
		};
		// A PDF's pages can still be read from the file
		if (text === TIMED_OUT && !attachment.isPDFAttachment()) {
			return Zotero.MCP.jsonResult({ ...result, notice: TEXT_PENDING });
		}
		if (text === null && !(fileExists && attachment.isPDFAttachment())) {
			throw new Zotero.MCP.ToolError(fileExists
				? `Zotero couldn't get any text from the file of ${attachment.key}`
				: `The file of ${attachment.key} isn't on this computer, and Zotero has no text for it`);
		}
		
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
		let pages = typeof text == 'string' ? text.split('\f') : [];
		let totalPages = (await Zotero.FullText.getPages(attachment.id))?.total;
		if (!totalPages) {
			let extracted = await extractPages(attachment, [0], deadline);
			if (extracted === TIMED_OUT) {
				return Zotero.MCP.jsonResult({ ...result, notice: TEXT_PENDING });
			}
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
		let structure = await getStructure(
			attachment,
			Math.min(deadline, Date.now() + Zotero.MCP.Tools._structureWait)
		);
		let pageResults = [];
		let chars = 0;
		let page = startPage;
		let textPending = false;
		for (; page <= endPage && (!pageResults.length || chars < maxChars); page++) {
			// Such as pages past the index limit (the fulltext.pdfMaxPages pref), a batch at a time
			if (pages[page - 1] === undefined) {
				let pageIndexes = [];
				for (let i = page - 1; i < Math.min(endPage, page - 1 + EXTRACT_PAGES); i++) {
					pageIndexes.push(i);
				}
				let extracted = await extractPages(attachment, pageIndexes, deadline);
				if (extracted === TIMED_OUT) {
					textPending = true;
					break;
				}
				pageIndexes.forEach((pageIndex, i) => {
					pages[pageIndex] = extracted.texts[i] ?? '';
				});
			}
			let pageText = (pages[page - 1] ?? '').trim();
			chars += pageText.length;
			pageResults.push({ page, label: structure?.labels?.[page - 1], text: pageText });
		}
		let notice;
		if (textPending) {
			notice = TEXT_PENDING;
		}
		else if (pageResults.every(({ text }) => !text)) {
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
			// Embedded images, in the order they're in the note
			let imageKeys = [...note.getNote().matchAll(/<img\b[^>]*\bdata-attachment-key="([^"]+)"/g)]
				.map(match => match[1]);
			let images = [];
			for (let key of imageKeys) {
				let image = Zotero.Items.getByLibraryAndKey(note.libraryID, key);
				let path = image && await image.getFilePathAsync();
				images.push({ key, path: path || undefined });
			}
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
				images: images.length ? images : undefined,
				link: getSelectLink(note),
			});
		}
		// In the order they're in the file, as in the reader's sidebar
		let sorted = [...annotations]
			.sort((a, b) => a.parentID - b.parentID
				|| (a.annotationSortIndex < b.annotationSortIndex ? -1 : 1));
		let annotationResults = [];
		for (let annotation of sorted) {
			let result = describeAnnotation(annotation);
			// Only an image already rendered, as rendering means opening the PDF
			if (IMAGE_ANNOTATION_TYPES.includes(annotation.annotationType)
					&& await Zotero.Annotations.hasCacheImage(annotation)) {
				result.imagePath = Zotero.Annotations.getCacheImagePath(annotation);
			}
			annotationResults.push(result);
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			notes: noteResults,
			annotations: annotationResults,
			missing: missing.length ? missing : undefined,
		});
	};
	
	/**
	 * Image files of image and ink annotations, rendering those not rendered yet from their
	 * PDFs, as the attachment pane does when it shows them
	 *
	 * Zotero renders all of a PDF's missing images at once, so asking for one also renders the
	 * others in its PDF.
	 */
	this.renderAnnotationImages = async function ({ keys, libraryID }, { deadline }) {
		libraryID = getLibraryID(libraryID);
		let annotations = [];
		for (let key of new Set(keys)) {
			let annotation = await getItem(libraryID, key);
			if (!annotation.isAnnotation() || !IMAGE_ANNOTATION_TYPES.includes(annotation.annotationType)) {
				throw new Zotero.MCP.ToolError(`${key} isn't an image or ink annotation`);
			}
			if (!annotation.parentItem.isPDFAttachment()) {
				throw new Zotero.MCP.ToolError(`${key} isn't in a PDF, and only PDFs' annotations can be rendered`);
			}
			annotations.push(annotation);
		}
		let attachmentIDs = new Set();
		for (let annotation of annotations) {
			if (!await Zotero.Annotations.hasCacheImage(annotation)) {
				attachmentIDs.add(annotation.parentID);
			}
		}
		let rendering = Promise.all([...attachmentIDs].map(
			id => Zotero.PDFWorker.renderAttachmentAnnotations(id, true).catch(e => Zotero.logError(e))
		));
		let pending = await untilDeadline(rendering, deadline) === TIMED_OUT;
		let images = [];
		for (let annotation of annotations) {
			let rendered = await Zotero.Annotations.hasCacheImage(annotation);
			images.push({
				key: annotation.key,
				path: rendered ? Zotero.Annotations.getCacheImagePath(annotation) : undefined,
				status: rendered ? 'rendered' : pending ? 'rendering' : 'failed',
			});
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			images,
			notice: [
				pending && 'Zotero is still rendering the images with status rendering. Call again shortly.',
				images.some(image => image.status == 'failed')
					&& "Zotero couldn't render the images with status failed, e.g. because the PDF isn't "
						+ 'on this computer.',
			].filter(Boolean).join(' ') || undefined,
		});
	};
	
	/**
	 * What the user is looking at in the most recently used main window: the selection of its
	 * library tab, and the open reader or note, and the tabs of every main window
	 */
	this.getContext = async function () {
		let win = Zotero.getMainWindow();
		if (!win?.Zotero_Tabs) {
			return Zotero.MCP.jsonResult({ window: false, windows: [] });
		}
		let { ZoteroPane, Zotero_Tabs } = win;
		let result = {
			window: true,
			windowID: Zotero_Tabs.windowID,
			tabID: Zotero_Tabs.selectedID,
			tab: Zotero_Tabs.selectedType,
		};
		// A window can have only reader and note tabs
		if (ZoteroPane.libraryView?.loaded) {
			let libraryID = ZoteroPane.getSelectedLibraryIDs()[0];
			let items = ZoteroPane.getSelectedItems(false, { libraryTabOnly: true });
			Object.assign(result, {
				libraryTabID: ZoteroPane.libraryView.tabID,
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
			});
		}
		
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
		result.windows = Zotero.getMainWindows()
			.filter(mainWindow => mainWindow.Zotero_Tabs)
			.map(mainWindow => ({
				windowID: mainWindow.Zotero_Tabs.windowID,
				current: mainWindow == win || undefined,
				tabs: getTabIDs(mainWindow).map(tabID => describeTab(mainWindow, tabID)),
			}));
		return Zotero.MCP.jsonResult(result);
	};
	
	/**
	 * Show a library, collection or saved search in a library tab, with some or all of its
	 * items selected
	 *
	 * This replaces what the tab shows, including any search and tag filter, so the items show.
	 * The window stays behind other apps' windows unless focus is given.
	 */
	this.select = async function ({
		libraryID, collectionKey, savedSearchKey, keys = [], allItems = false, windowID, tabID,
		newWindow = false, newTab = false, focus = false,
	}, { deadline }) {
		libraryID = getLibraryID(libraryID);
		if (collectionKey && savedSearchKey) {
			throw new Zotero.MCP.ToolError('Give collectionKey or savedSearchKey, not both');
		}
		if (keys.length && allItems) {
			throw new Zotero.MCP.ToolError('Give keys or allItems, not both');
		}
		checkWhere({ windowID, tabID, newWindow, newTab });
		let rowID = 'L' + libraryID;
		if (collectionKey) {
			rowID = 'C' + getCollection(libraryID, collectionKey).id;
		}
		else if (savedSearchKey) {
			let search = Zotero.Searches.getByLibraryAndKey(libraryID, savedSearchKey);
			if (!search || search.deleted) {
				throw new Zotero.MCP.ToolError(`No saved search ${savedSearchKey} in library ${libraryID}`);
			}
			rowID = 'S' + search.id;
		}
		let items = [];
		let missing = [];
		for (let key of new Set(keys)) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
			if (!item || item.deleted) {
				missing.push(key);
			}
			else {
				items.push(item);
			}
		}
		// As a library tab saves what it shows (see LibraryView#captureLibraryTabState())
		let state = { collections: [rowID], focusedCollection: rowID, items: items.map(item => item.id) };
		
		// By default, the most recently used window, or a new one if there's none
		let win = newWindow ? null : getMainWindow(windowID, tabID) ?? Zotero.getMainWindow();
		let view;
		if (!win) {
			win = Zotero.openMainWindow({ libraryTabState: state });
			view = await waitForLibraryView(win, null, deadline);
		}
		else {
			let { Zotero_Tabs, ZoteroPane } = win;
			if (tabID && !Zotero_Tabs.isLibraryTab(tabID)) {
				throw new Zotero.MCP.ToolError(`${tabID} isn't a library tab`);
			}
			let viewTabID = tabID ?? ZoteroPane.libraryView?.tabID;
			if (newTab || !viewTabID) {
				Zotero_Tabs.addLibraryTab({ state, select: true });
				view = await waitForLibraryView(win, Zotero_Tabs.selectedID, deadline);
			}
			else {
				Zotero_Tabs.select(viewTabID);
				view = await waitForLibraryView(win, viewTabID, deadline);
				await view.restoreLibraryTabState(state);
			}
		}
		if (allItems) {
			view.itemsView.selection.selectAll();
		}
		if (focus) {
			Zotero.Utilities.Internal.activate(win);
		}
		let selected = view.itemsView.getSelectedObjects();
		return Zotero.MCP.jsonResult({
			windowID: win.Zotero_Tabs.windowID,
			tabID: view.tabID,
			libraryID,
			selectedCount: selected.length,
			// Items that aren't in the collection or saved search
			notShown: items.filter(item => !selected.includes(item)).map(item => item.key),
			missing: missing.length ? missing : undefined,
		});
	};
	
	/**
	 * Open a file in Zotero's reader, or a note, in a tab or a window of its own, and scroll the
	 * reader to a page or an annotation. If the file or note is already open, its tab is
	 * selected instead, unless newTab is given.
	 */
	this.open = async function ({
		key, page, pageLabel, annotationKey, windowID, newWindow = false, newTab = false,
		focus = false, libraryID,
	}, { deadline }) {
		libraryID = getLibraryID(libraryID);
		checkWhere({ windowID, newWindow, newTab });
		if ([page, pageLabel, annotationKey].filter(x => x !== undefined).length > 1) {
			throw new Zotero.MCP.ToolError('Give page, pageLabel or annotationKey, not more than one');
		}
		let item = await getItem(libraryID, key);
		if (item.isRegularItem()) {
			item = await item.getBestAttachment();
			if (!item) {
				throw new Zotero.MCP.ToolError(`${key} has no PDF, EPUB or snapshot to open`);
			}
		}
		let location;
		if (annotationKey) {
			let annotation = await getItem(libraryID, annotationKey);
			if (!annotation.isAnnotation() || annotation.parentItemID != item.id) {
				throw new Zotero.MCP.ToolError(`${annotationKey} isn't an annotation of ${item.key}`);
			}
			location = { annotationID: annotation.key };
		}
		else if (page !== undefined) {
			if (!item.isPDFAttachment()) {
				throw new Zotero.MCP.ToolError(`${item.key} isn't a PDF. Give pageLabel for an EPUB.`);
			}
			location = { pageIndex: page - 1 };
		}
		else if (pageLabel !== undefined) {
			if (item.isPDFAttachment()) {
				location = { pageLabel };
			}
			else if (item.isEPUBAttachment()) {
				location = { pageNumber: pageLabel };
			}
			else {
				throw new Zotero.MCP.ToolError(`${item.key} has no pages. Give annotationKey to scroll to.`);
			}
		}
		
		let options = {
			// Zotero can be running without a window, on macOS
			openInWindow: newWindow || !Zotero.getMainWindow(),
			allowDuplicate: newTab,
			// By default, where the file or note is already open, or else the most recent window
			window: getMainWindow(windowID)
				?? (newTab ? null : Zotero.getMainWindows().find(win => getTabIDs(win, item).length))
				?? Zotero.getMainWindow(),
		};
		if (item.isNote()) {
			if (location) {
				throw new Zotero.MCP.ToolError(`${item.key} is a note, which has no pages or annotations`);
			}
			await Zotero.Notes.open(item.id, null, options);
		}
		else if (item.isAttachment() && item.attachmentReaderType) {
			if (!await item.fileExists()) {
				throw new Zotero.MCP.ToolError(`The file of ${item.key} isn't on this computer`);
			}
			await Zotero.Reader.open(item.id, location, options);
		}
		else {
			throw new Zotero.MCP.ToolError(
				`${item.key} can't be opened in Zotero: only PDFs, EPUBs, web page snapshots and notes can`
			);
		}
		// A new window adds its tab as it loads
		while (!Zotero.getMainWindows().some(win => win.Zotero_Tabs && getTabIDs(win, item).length)
				&& Date.now() < deadline) {
			await Zotero.Promise.delay(20);
		}
		// The tab that's showing it: the selected one in its window, or else the newest
		let win, tabID;
		for (let mainWindow of Zotero.getMainWindows().filter(win => win.Zotero_Tabs)) {
			let tabIDs = getTabIDs(mainWindow, item);
			if (!tabIDs.length) {
				continue;
			}
			let selected = tabIDs.find(id => id == mainWindow.Zotero_Tabs.selectedID);
			if (selected || !win || mainWindow == options.window) {
				win = mainWindow;
				tabID = selected ?? tabIDs.at(-1);
			}
			if (selected && mainWindow == options.window) {
				break;
			}
		}
		if (focus && win) {
			Zotero.Utilities.Internal.activate(win);
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			key: item.key,
			title: item.isNote() ? item.getNoteTitle() : getTitle(item),
			windowID: win?.Zotero_Tabs.windowID,
			tabID,
		});
	};
	
	/**
	 * Close tabs and main windows. Zotero's last main window, or its last tab, stays open except
	 * on macOS, since closing it quits Zotero.
	 */
	this.close = async function ({ tabIDs = [], windowIDs = [] }) {
		if (!tabIDs.length && !windowIDs.length) {
			throw new Zotero.MCP.ToolError('Give tabIDs or windowIDs');
		}
		let windows = new Set(windowIDs.map(id => getMainWindow(id)));
		// Tabs to close, by window
		let tabs = new Map();
		for (let tabID of new Set(tabIDs)) {
			let win = getMainWindow(null, tabID);
			if (windows.has(win)) {
				continue;
			}
			let { tab } = win.Zotero_Tabs._getTab(tabID);
			if (tab.pinned) {
				throw new Zotero.MCP.ToolError(`${tabID} is pinned. The user can unpin it.`);
			}
			if (!tab.closable) {
				throw new Zotero.MCP.ToolError(`${tabID} can't be closed`);
			}
			tabs.set(win, [...tabs.get(win) ?? [], tabID]);
		}
		let remaining = Zotero.getMainWindows().filter(
			win => !windows.has(win) && getTabIDs(win).length > (tabs.get(win)?.length ?? 0)
		);
		if (!remaining.length && !Zotero.isMac) {
			throw new Zotero.MCP.ToolError(
				"That would close Zotero's last window, which quits Zotero. Leave a tab open."
			);
		}
		let closedWindows = [...windows].map(win => win.Zotero_Tabs.windowID);
		for (let [win, ids] of tabs) {
			win.Zotero_Tabs.close(ids);
		}
		for (let win of windows) {
			win.close();
		}
		return Zotero.MCP.jsonResult({
			closedTabs: [...tabs.values()].flat(),
			closedWindows,
		});
	};
	
	/**
	 * Citations and bibliographies in a CSL style
	 */
	this.generateCitation = async function ({
		items: refs, citations: clusters, format, style, locale, html = false, libraryID,
	}, call) {
		libraryID = getLibraryID(libraryID);
		if (format == 'document' ? !clusters?.length || refs : !refs?.length || clusters) {
			throw new Zotero.MCP.ToolError(
				'Give citations for format document, and items for format citation or bibliography'
			);
		}
		let items = [];
		let missing = [];
		for (let ref of format == 'document' ? clusters.flat() : refs) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.key);
			if (!item || item.deleted) {
				missing.push(ref.key);
			}
			items.push(item);
		}
		if (missing.length) {
			throw new Zotero.MCP.ToolError(`No items ${missing.join(', ')} in library ${libraryID}`);
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
			call
		);
		locale = locale
			|| (quickCopy.mode == 'bibliography' && quickCopy.locale)
			|| Zotero.Prefs.get('export.quickCopy.locale')
			|| Zotero.locale;
		let outputFormat = html ? 'html' : 'text';
		let engine = style.getCiteProc(locale, outputFormat);
		let itemIDs = new Map(items.map(item => [item.key, item.id]));
		let toCitationItem = ref => ({
			id: itemIDs.get(ref.key),
			locator: ref.locator,
			label: ref.locator ? (ref.label ?? 'page') : undefined,
		});
		let result = {
			libraryID,
			format,
			style: style.styleID,
			styleTitle: style.title,
			locale: engine.opt.lang,
		};
		if (format == 'document') {
			// Formatted together, as in a word processor document, so that numbering,
			// disambiguation and ibid. follow from the citations before each one
			let noteStyle = engine.opt.xclass == 'note';
			let formatted = engine.rebuildProcessorState(
				clusters.map((cluster, i) => ({
					citationID: String(i),
					citationItems: cluster.map(toCitationItem),
					// Each citation in a footnote of its own
					properties: { noteIndex: noteStyle ? i + 1 : 0 },
				})),
				outputFormat
			);
			result.noteStyle = noteStyle;
			result.citations = formatted.map(([, , output]) => output);
			result.bibliography = (Zotero.Cite.makeFormattedBibliography(engine, outputFormat) || '').trim();
		}
		else if (format == 'citation') {
			engine.updateItems(items.map(item => item.id));
			let citation = { citationItems: refs.map(toCitationItem), properties: {} };
			result.output = engine.previewCitationCluster(citation, [], [], outputFormat).trim();
		}
		else {
			result.output = Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, items, outputFormat).trim();
		}
		return Zotero.MCP.jsonResult(result);
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
	 * Create a saved search from a query in zotero_search's syntax, or rename one or change
	 * its query
	 */
	this.manageSavedSearches = async function ({
		action, key, name, query, mode = Zotero.Prefs.get('search.quicksearch-mode'), libraryID,
	}, { clientID }) {
		libraryID = getLibraryID(libraryID);
		name = name?.trim();
		query = query?.trim();
		if (action == 'create' ? !name || !query : !name && !query) {
			throw new Zotero.MCP.ToolError(
				action == 'create' ? 'create needs a name and a query' : 'update needs a name or a query'
			);
		}
		let search;
		if (action == 'create') {
			search = new Zotero.Search({ libraryID });
		}
		else {
			search = key && Zotero.Searches.getByLibraryAndKey(libraryID, key);
			if (!search || search.deleted) {
				throw new Zotero.MCP.ToolError(`No saved search ${key} in library ${libraryID}`);
			}
		}
		if (!search.isEditable()) {
			throw new Zotero.MCP.ToolError(`${search.key} can't be changed`);
		}
		let conditions;
		if (query) {
			let parsed = Zotero.SearchQuery.getSearch(query, { libraryID, mode });
			if (!parsed) {
				parsed = new Zotero.Search({ libraryID });
				parsed.addCondition('quicksearch-' + mode, 'contains', query);
			}
			conditions = parsed.toJSON().conditions;
		}
		try {
			await edit(clientID, async () => {
				search.fromJSON({
					name: name || search.name,
					conditions: conditions || search.toJSON().conditions,
				});
				// Not selected, so as not to disturb the user
				await search.save({ skipSelect: true });
			});
		}
		catch (e) {
			if (search.id) {
				await search.reload(null, true);
			}
			throw e;
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			key: search.key,
			name: search.name,
			conditions: search.toJSON().conditions,
			itemCount: await countSearchItems(search),
			link: `zotero://select/${Zotero.API.getLibraryPrefix(libraryID)}/searches/${search.key}`,
		});
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
			dateModified: Zotero.Date.sqlToISO8601(note.dateModified),
			link: getSelectLink(note),
		});
	};
	
	/**
	 * Rename, merge or delete tags across a library, or set a tag's color
	 *
	 * Renaming and deleting change each item that has the tag, as one undo step, rather than
	 * through Zotero.Tags.rename() and removeFromLibrary(), which write to the database
	 * directly and so can't be undone. Colors are a synced setting, outside the undo history.
	 */
	this.manageTags = async function ({ action, tags, newName, color, position, libraryID }, { clientID }) {
		libraryID = getLibraryID(libraryID);
		let library = Zotero.Libraries.get(libraryID);
		if (!library.editable) {
			throw new Zotero.MCP.ToolError(`${library.name} can't be edited`);
		}
		tags = [...new Set(tags.map(tag => tag.trim()))];
		newName = newName?.trim();
		if (tags.some(tag => !tag) || action == 'rename' && !newName) {
			throw new Zotero.MCP.ToolError('Tags must not be empty');
		}
		if ((action == 'rename') != (newName !== undefined)) {
			throw new Zotero.MCP.ToolError('Give newName to rename, and only then');
		}
		let colors = Zotero.Tags.getColors(libraryID);
		
		if (action == 'setColor') {
			let [tag] = tags;
			if (tags.length != 1) {
				throw new Zotero.MCP.ToolError('Give one tag to color');
			}
			if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
				throw new Zotero.MCP.ToolError('Give color as #rrggbb, or null to remove it');
			}
			if (color && !colors.has(tag) && colors.size >= Zotero.Tags.MAX_COLORED_TAGS) {
				throw new Zotero.MCP.ToolError(
					`Only ${Zotero.Tags.MAX_COLORED_TAGS} tags can have colors, one per number key. `
						+ 'Remove the color of another tag first.'
				);
			}
			await Zotero.Tags.setColor(libraryID, tag, color || false, position && position - 1);
			let set = Zotero.Tags.getColor(libraryID, tag);
			return Zotero.MCP.jsonResult({
				libraryID,
				action,
				tag,
				color: set ? set.color : undefined,
				position: set ? set.position + 1 : undefined,
			});
		}
		
		if (action == 'rename') {
			tags = tags.filter(tag => tag != newName);
			if (!tags.length) {
				throw new Zotero.MCP.ToolError(`The tag is already named ${JSON.stringify(newName)}`);
			}
		}
		let itemIDs = new Set();
		let missing = [];
		for (let tag of tags) {
			let tagID = Zotero.Tags.getID(tag);
			let ids = tagID ? await Zotero.Tags.getTagItems(libraryID, tagID) : [];
			if (!ids.length) {
				missing.push(tag);
			}
			ids.forEach(id => itemIDs.add(id));
		}
		if (missing.length) {
			throw new Zotero.MCP.ToolError(
				`No items in ${library.name} have the tags ${missing.map(tag => JSON.stringify(tag)).join(', ')}. `
					+ 'Tags match exactly, including case: see zotero_list_tags.'
			);
		}
		let items = await Zotero.Items.getAsync([...itemIDs]);
		await Zotero.Items.loadDataTypes(items);
		// A renamed tag keeps its color, as when the user renames it, unless the new name has one
		let keptColor = action == 'rename' && !colors.has(newName)
			? tags.map(tag => colors.get(tag)).find(Boolean)
			: null;
		await edit(clientID, async () => {
			for (let item of items) {
				for (let tag of tags) {
					if (action == 'rename' && !item.hasTag(newName)) {
						item.replaceTag(tag, newName);
					}
					else {
						item.removeTag(tag);
					}
				}
				await item.save({ skipSelect: true });
			}
			for (let tag of tags) {
				if (colors.has(tag)) {
					await Zotero.Tags.setColor(libraryID, tag, false);
				}
			}
			if (keptColor) {
				await Zotero.Tags.setColor(libraryID, newName, keptColor.color, keptColor.position);
			}
		});
		// Removes the tags no item has anymore
		Zotero.Prefs.set('purge.tags', true);
		return Zotero.MCP.jsonResult({
			libraryID,
			action,
			itemCount: items.length,
		});
	};
	
	/**
	 * Add Markdown to the end of a note, or replace its content
	 *
	 * Refuses if the note changed since the model read it, so an edit the user made in the
	 * meantime isn't lost, and refuses to replace content Markdown can't hold: highlights and
	 * citations linked to items, and images stored in Zotero.
	 */
	this.editNote = async function ({ key, markdown, mode = 'append', dateModified, libraryID }, { clientID }) {
		libraryID = getLibraryID(libraryID);
		if (!markdown.trim()) {
			throw new Zotero.MCP.ToolError('The Markdown must not be empty');
		}
		let note = await getItem(libraryID, key);
		if (!note.isNote()) {
			throw new Zotero.MCP.ToolError(`${note.key} isn't a note`);
		}
		if (!note.isEditable()) {
			throw new Zotero.MCP.ToolError(`${note.key} can't be edited`);
		}
		if (Zotero.Date.sqlToISO8601(note.dateModified) != dateModified) {
			throw new Zotero.MCP.ToolError(
				`The note has changed since ${dateModified}, maybe because the user edited it. `
					+ 'Get it again with zotero_get_notes, then make the edit to what it is now.'
			);
		}
		let html = markdownToNoteHTML(markdown);
		if (mode == 'replace') {
			if (/\sdata-(annotation|citation|attachment-key)=/.test(note.getNote())) {
				throw new Zotero.MCP.ToolError(
					"The note has highlights, citations or images that Markdown can't hold, which "
						+ 'replacing it would lose. Append to it instead, or ask the user to make the change.'
				);
			}
		}
		else {
			// Inside the note's own wrapper, which carries its schema version and citation data
			let [, wrapper, content] = note.getNote()
				.match(/^\s*(<div\b[^>]*\bdata-schema-version="[^"]*"[^>]*>)([\s\S]*)<\/div>\s*$/)
				?? [null, '<div data-schema-version="9">', note.getNote()];
			html = wrapper + content + html.replace(/^<div[^>]*>|<\/div>$/g, '') + '</div>';
		}
		try {
			await edit(clientID, () => {
				note.setNote(html);
				return note.save({ skipSelect: true });
			});
		}
		catch (e) {
			// The transaction was rolled back, but the note still has the change in memory
			await note.reload(null, true);
			throw e;
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			key: note.key,
			parentKey: note.parentKey || undefined,
			title: note.getNoteTitle(),
			dateModified: Zotero.Date.sqlToISO8601(note.dateModified),
			link: getSelectLink(note),
		});
	};
	
	/**
	 * Sets of items Zotero considers duplicates, as its Duplicate Items view shows them
	 */
	this.listDuplicates = async function ({ libraryID, limit = 20, offset = 0 }) {
		libraryID = getLibraryID(libraryID);
		let sets = await Promise.all(
			(await new Zotero.Duplicates(libraryID).getSets()).map(ids => Zotero.Items.getAsync(ids))
		);
		for (let set of sets) {
			set.sort((a, b) => (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : 0));
		}
		sets.sort((a, b) => Zotero.localeCompare(a[0].getDisplayTitle(), b[0].getDisplayTitle()));
		let page = sets.slice(offset, offset + limit);
		return Zotero.MCP.jsonResult({
			libraryID,
			total: sets.length,
			sets: await Promise.all(page.map(set => Promise.all(set.map(async item => ({
				...await summarize(item),
				DOI: item.getField('DOI') || undefined,
				ISBN: item.getField('ISBN') || undefined,
				dateAdded: Zotero.Date.sqlToISO8601(item.dateAdded),
				attachmentCount: item.numAttachments(),
				noteCount: item.numNotes(),
			}))))),
			nextOffset: offset + limit < sets.length ? offset + limit : undefined,
		});
	};
	
	/**
	 * Merge duplicates as Zotero's merge pane does: the master item gets the others' notes,
	 * attachments, tags, collections and relations, and the others go to the trash
	 */
	this.mergeItems = async function ({ keys, masterKey, libraryID }, { clientID }) {
		libraryID = getLibraryID(libraryID);
		keys = [...new Set(keys)];
		if (keys.length < 2) {
			throw new Zotero.MCP.ToolError('Give at least two items to merge');
		}
		let items = [];
		for (let key of keys) {
			let item = await getItem(libraryID, key);
			if (!item.isRegularItem()) {
				throw new Zotero.MCP.ToolError(
					`${item.key} is ${item.isNote() ? 'a note' : 'an ' + item.itemType}. Only regular items can be merged.`
				);
			}
			if (!item.isEditable()) {
				throw new Zotero.MCP.ToolError(`${item.key} can't be changed`);
			}
			items.push(item);
		}
		if (new Set(items.map(item => item.itemTypeID)).size > 1) {
			throw new Zotero.MCP.ToolError(
				'Items of different types can\'t be merged. The user can change an item\'s type in Zotero\'s item pane.'
			);
		}
		// The oldest by default, as in the merge pane
		let master = masterKey
			? items.find(item => item.key == masterKey)
			: items.reduce((oldest, item) => (item.dateAdded < oldest.dateAdded ? item : oldest));
		if (!master) {
			throw new Zotero.MCP.ToolError('masterKey must be one of keys');
		}
		let others = items.filter(item => item != master);
		let { mergeItems } = ChromeUtils.importESModule('chrome://zotero/content/mergeItems.mjs');
		await mergeItems(master, others, {
			undoAction: 'undo-action-mcp-changes',
			undoActionArgs: { app: Zotero.MCP.Apps.getDisplayName(clientID) },
		});
		return Zotero.MCP.jsonResult({
			libraryID,
			key: master.key,
			trashed: others.map(item => item.key),
			link: getSelectLink(master),
		});
	};
	
	/**
	 * Move items and collections to the trash, or restore them from it
	 *
	 * Trashing needs DELETE, but restoring only EDIT_LIBRARY, so this asks for the permission
	 * itself instead of declaring one in tools.json.
	 */
	this.trash = async function ({ keys = [], collectionKeys = [], savedSearchKeys = [], restore = false, libraryID }, call) {
		libraryID = getLibraryID(libraryID);
		let library = Zotero.Libraries.get(libraryID);
		if (!library.editable || !library.hasTrash) {
			throw new Zotero.MCP.ToolError(`${library.name} is read-only`);
		}
		if (!keys.length && !collectionKeys.length && !savedSearchKeys.length) {
			throw new Zotero.MCP.ToolError('Give keys, collectionKeys or savedSearchKeys');
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
		let searches = [...new Set(savedSearchKeys)]
			.map(key => check(Zotero.Searches.getByLibraryAndKey(libraryID, key), 'saved search', key));
		// Subcollections go with their collection
		collections = collections.filter(collection => !collections.some(
			other => other != collection && other.hasDescendent('collection', collection.id)
		));
		
		let { EDIT_LIBRARY, DELETE } = Zotero.MCP.Permissions;
		await Zotero.MCP.Permissions.require(call.clientID, restore ? EDIT_LIBRARY : DELETE, libraryID, call);
		await edit(call.clientID, async () => {
			if (!restore) {
				await Zotero.Items.trash(items.map(item => item.id));
				for (let object of [...collections, ...searches]) {
					object.deleted = true;
					await object.save();
				}
				return;
			}
			// As when the user restores only parent items and collections in the trash
			// (ZoteroPane.restoreSelectedItems()), their children come back too
			let restored = [...items, ...collections, ...searches];
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
			savedSearches: searches.map(search => search.key),
		});
	};
	
	/**
	 * Add items by identifier or from item JSON, and look for their files
	 *
	 * Translators save in their own transactions, which can't be nested, so their items are
	 * made one undo step afterwards, with any JSON items.
	 *
	 * Identifiers are looked up a few at a time. Lookups still running at the call's deadline
	 * can't be stopped, as each saves its items when it finishes, so they're reported as
	 * inProgress and go on in the background, where their items become a later undo step.
	 */
	this.addItems = async function ({
		identifiers = [], items: json = [], collectionKey,
		findFiles = Zotero.Prefs.get('downloadAssociatedFiles'), libraryID,
	}, { clientID, deadline }) {
		libraryID = getLibraryID(libraryID);
		if (!identifiers.length && !json.length) {
			throw new Zotero.MCP.ToolError('Give identifiers or items');
		}
		let collections = collectionKey ? [getCollection(libraryID, collectionKey).id] : false;
		
		// Checked before anything is added
		let jsonItems = json.map((data, i) => itemFromJSON(libraryID, data, `items[${i}]`));
		
		// { input, status, item, error }, or { lookup } in place of a lookup's results
		let results = [];
		let lookups = [];
		for (let input of identifiers) {
			let found = extractIdentifiers(input);
			if (!found.length) {
				results.push({
					input,
					status: 'failed',
					error: 'No DOI, ISBN, arXiv ID or PubMed ID found. Zotero only adds web pages '
						+ 'through the Zotero Connector. Find an identifier, or give the metadata '
						+ 'as items.',
				});
				continue;
			}
			for (let identifier of found) {
				let lookup = { input, identifier, results: null };
				lookups.push(lookup);
				results.push({ lookup });
			}
		}
		let queue = [...lookups];
		let lookUpNext = async () => {
			for (let lookup = queue.shift(); lookup; lookup = queue.shift()) {
				lookup.results = await lookUp(lookup, libraryID, collections);
			}
		};
		let lookedUp = Promise.all(Array.from({ length: LOOKUP_CONCURRENCY }, lookUpNext));
		await Promise.race([lookedUp, Zotero.Promise.delay(Math.max(0, deadline - Date.now()))]);
		let pending = lookups.filter(lookup => !lookup.results);
		results = results.flatMap(({ lookup, ...result }) => {
			if (!lookup) {
				return [result];
			}
			return lookup.results ?? [{ input: lookup.input, status: 'inProgress' }];
		});
		// Saved by translators
		let translated = results.filter(result => result.status == 'added').map(result => result.item);
		for (let [i, item] of jsonItems.entries()) {
			results.push({ input: `items[${i}]`, status: 'added', item });
		}
		
		await edit(clientID, async () => {
			for (let item of translated) {
				Zotero.UndoHistory.stageCreation(item);
			}
			for (let item of jsonItems) {
				if (collections) {
					item.setCollections(collections);
				}
				await item.save({ skipSelect: true });
			}
		});
		if (pending.length) {
			lookedUp.then(() => addLookedUpLate(pending, clientID, findFiles)).catch(e => Zotero.logError(e));
		}
		
		// Like Find Available PDF, for new items that can have one
		let searched = new Set();
		let searching = false;
		if (findFiles) {
			let items = [...translated, ...jsonItems].filter(item => Zotero.Attachments.canFindFileForItem(item));
			items.forEach(item => searched.add(item));
			if (items.length) {
				let search = Zotero.Attachments.addAvailableFiles(items);
				search.catch(e => Zotero.logError(e));
				searching = await Promise.race([
					search.then(() => false, () => false),
					Zotero.Promise.delay(Math.max(0, deadline - Date.now())).then(() => true),
				]);
			}
		}
		
		let notices = new Set();
		if (pending.length) {
			notices.add(LOOKUPS_PENDING);
		}
		let output = [];
		for (let { input, status, item, error } of results) {
			if (!item) {
				output.push({ input, status, error });
				continue;
			}
			let summary = await summarize(item);
			if (searched.has(item) && !summary.file) {
				summary.fileSearch = searching ? 'searching' : 'notFound';
				notices.add(searching ? FILES_PENDING : FILES_NOT_FOUND);
			}
			output.push({ input, status, ...summary });
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			results: output,
			notice: notices.size ? [...notices].join(' ') : undefined,
		});
	};
	
	/**
	 * Look up an identifier for zotero_add_items, saving the items found
	 *
	 * @return {Promise<Object[]>} Its results, { input, status, item, error }
	 */
	async function lookUp({ input, identifier }, libraryID, collections) {
		try {
			let translate = new Zotero.Translate.Search();
			translate.setIdentifier(identifier);
			translate.setTranslator(await translate.getTranslators());
			// Files are found afterwards instead, so the call doesn't wait for downloads
			let items = await translate.translate({ libraryID, collections, saveAttachments: false });
			if (!items.length) {
				throw new Error('No items');
			}
			return items.map(item => ({ input, status: 'added', item }));
		}
		catch (e) {
			Zotero.debug(e, 2);
			return [{
				input,
				status: 'failed',
				error: `Zotero couldn't find ${Object.keys(identifier)[0]} `
					+ `${Object.values(identifier)[0]}. Check it, or give the metadata as items.`,
			}];
		}
	}
	
	/**
	 * Make the items of lookups that finished after zotero_add_items returned one undo step of
	 * their own, and look for their files
	 */
	async function addLookedUpLate(lookups, clientID, findFiles) {
		let items = lookups.flatMap(lookup => lookup.results)
			.filter(result => result.status == 'added')
			.map(result => result.item);
		if (!items.length) {
			return;
		}
		await edit(clientID, async () => {
			for (let item of items) {
				Zotero.UndoHistory.stageCreation(item);
			}
		});
		let findable = findFiles ? items.filter(item => Zotero.Attachments.canFindFileForItem(item)) : [];
		if (findable.length) {
			await Zotero.Attachments.addAvailableFiles(findable);
		}
	}
	
	/**
	 * Attach a file to an item from a URL or this computer, or add a file from this computer
	 * as a standalone attachment, which Zotero identifies as with Retrieve Metadata
	 */
	this.addAttachment = async function ({
		parentKey, url, path, linkFile = false, title, collectionKey, libraryID,
	}, { clientID, deadline }) {
		libraryID = getLibraryID(libraryID);
		let library = Zotero.Libraries.get(libraryID);
		if (!library.editable || !library.filesEditable) {
			throw new Zotero.MCP.ToolError(`Files can't be added to ${library.name}`);
		}
		if (!url == !path) {
			throw new Zotero.MCP.ToolError('Give url or path');
		}
		if (url && linkFile) {
			throw new Zotero.MCP.ToolError('Only a file from path can be linked');
		}
		if (linkFile && library.libraryType != 'user') {
			throw new Zotero.MCP.ToolError('Files can be linked only in My Library');
		}
		if (!parentKey) {
			if (url) {
				throw new Zotero.MCP.ToolError('Give parentKey to attach a file from a URL');
			}
			return addStandaloneFile({ path, linkFile, title, collectionKey, libraryID }, { clientID, deadline });
		}
		if (collectionKey) {
			throw new Zotero.MCP.ToolError("Give collectionKey only without parentKey. A file is in its parent's collections.");
		}
		let parent = await getItem(libraryID, parentKey);
		if (!parent.isRegularItem()) {
			throw new Zotero.MCP.ToolError(
				`${parent.key} is ${parent.isNote() ? 'a note' : 'an ' + parent.itemType}. Files can only `
					+ 'be attached to regular items, such as a journal article.'
			);
		}
		// Makes the new attachment an undo step
		let finish = async (attachment) => {
			await edit(clientID, async () => {
				Zotero.UndoHistory.stageCreation(attachment);
				// The title of a downloaded file comes from where it was found, e.g. "Full Text PDF"
				if (title) {
					attachment.setField('title', title);
					await attachment.save();
				}
			});
			return attachment;
		};
		let attachment;
		if (url) {
			if (!/^https?:\/\//i.test(url)) {
				throw new Zotero.MCP.ToolError('Only http and https URLs can be attached');
			}
			// A link to the file, or a page that links to it, as Find Available PDF follows
			let download = Zotero.Attachments.addFileFromURLs(parent, [{ pageURL: url }])
				.catch((e) => {
					Zotero.debug(e, 2);
					return false;
				})
				// Finished also when the download outlasts the call
				.then(attachment => attachment && finish(attachment));
			download.catch(e => Zotero.logError(e));
			attachment = await Promise.race([
				download,
				Zotero.Promise.delay(Math.max(0, deadline - Date.now())).then(() => null),
			]);
			if (attachment === null) {
				return Zotero.MCP.jsonResult({
					libraryID,
					parentKey: parent.key,
					status: 'downloading',
					notice: 'Zotero is still downloading the file. Call zotero_get_items on the '
						+ 'parent item later to see whether it was attached.',
				});
			}
			if (!attachment) {
				throw new Zotero.MCP.ToolError(
					`Zotero couldn't get a PDF or EPUB from ${url}: it isn't a link to one, the `
						+ "page doesn't link to one Zotero recognizes, or the site requires signing in "
						+ 'or blocks automated downloads. Try a direct link to the file. ' + LAST_RESORT
				);
			}
		}
		else {
			let info = await statPath(path);
			if (info?.type != 'regular') {
				throw new Zotero.MCP.ToolError(`There's no file at ${path} on this computer.`);
			}
			if (linkFile) {
				attachment = await finish(await Zotero.Attachments.linkFromFile({
					file: path,
					parentItemID: parent.id,
					saveOptions: { skipSelect: true },
				}));
			}
			else {
				// Renamed as when the user adds the item's first file (ZoteroPane.addAttachmentFromDialog())
				let fileBaseName;
				if (Zotero.Attachments.shouldAutoRenameFile(false, libraryID) && !parent.numNonHTMLFileAttachments()) {
					fileBaseName = await Zotero.Attachments.getRenamedFileBaseNameIfAllowedType(parent, path);
				}
				attachment = await finish(await Zotero.Attachments.importFromFile({
					file: path,
					parentItemID: parent.id,
					fileBaseName,
					saveOptions: { skipSelect: true },
				}));
			}
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			parentKey: parent.key,
			status: 'attached',
			...await describeAttachment(attachment),
			link: getOpenLink(attachment),
		});
	};
	
	/**
	 * Find Full Text for existing items, as the item menu does, with what it found for each
	 *
	 * The files found become one undo step once the search ends, which can be after the
	 * call's deadline.
	 */
	this.findFullText = async function ({ keys, libraryID }, { clientID, deadline }) {
		libraryID = getLibraryID(libraryID);
		let library = Zotero.Libraries.get(libraryID);
		if (!library.editable || !library.filesEditable) {
			throw new Zotero.MCP.ToolError(`Files can't be added to ${library.name}`);
		}
		let items = [];
		for (let key of new Set(keys)) {
			items.push(await getItem(libraryID, key));
		}
		let eligible = items.filter(item => Zotero.Attachments.canFindFileForItem(item));
		let before = new Map(eligible.map(item => [item, new Set(item.getAttachments())]));
		let added = item => Zotero.Items.get(item.getAttachments().filter(id => !before.get(item).has(id)));
		let finding = (async () => {
			if (eligible.length) {
				await Zotero.Attachments.addAvailableFiles(eligible);
			}
			let attachments = eligible.flatMap(added);
			if (attachments.length) {
				await edit(clientID, async () => {
					for (let attachment of attachments) {
						Zotero.UndoHistory.stageCreation(attachment);
					}
				});
			}
		})();
		finding.catch(e => Zotero.logError(e));
		let searching = await untilDeadline(finding, deadline) === TIMED_OUT;
		let results = await Promise.all(items.map(async (item) => {
			let result = { key: item.key, title: item.getDisplayTitle() };
			if (!before.has(item)) {
				result.status = 'skipped';
				result.reason = !item.isRegularItem()
					? 'Only regular items, such as a journal article, can have files found'
					: Zotero.Attachments.FIND_AVAILABLE_FILE_TYPES
						.some(type => item.numFileAttachmentsWithContentType(type))
						? 'It already has a PDF or EPUB'
						: 'It has no DOI, URL or PMCID to look for a file by';
				return result;
			}
			let [attachment] = added(item);
			if (attachment) {
				result.status = 'found';
				result.file = await describeAttachment(attachment);
			}
			else {
				result.status = searching ? 'searching' : 'notFound';
			}
			return result;
		}));
		return Zotero.MCP.jsonResult({
			libraryID,
			results,
			notice: [
				searching && 'Zotero is still looking for files for the items with status searching. '
					+ 'Call zotero_get_items on them later to see whether it found one.',
				results.some(result => result.status == 'notFound')
					&& "Zotero found no PDF or EPUB for items with status notFound. Find one elsewhere "
						+ "(e.g. arXiv, PubMed Central or the author's site) and attach it with "
						+ 'zotero_add_attachment. ' + LAST_RESORT,
			].filter(Boolean).join(' ') || undefined,
		});
	};
	
	/**
	 * Add a file as a standalone attachment and identify it, creating its parent item from the
	 * metadata found, as when the user adds a PDF or EPUB on its own
	 *
	 * The file and its new parent become one undo step once identifying ends, which can be
	 * after the call's deadline.
	 */
	async function addStandaloneFile({ path, linkFile, title, collectionKey, libraryID }, { clientID, deadline }) {
		let collection = collectionKey ? getCollection(libraryID, collectionKey) : null;
		let info = await statPath(path);
		if (info?.type != 'regular') {
			throw new Zotero.MCP.ToolError(`There's no file at ${path} on this computer.`);
		}
		let options = {
			file: path,
			libraryID,
			collections: collection ? [collection.id] : undefined,
			saveOptions: { skipSelect: true },
		};
		let attachment = linkFile
			? await Zotero.Attachments.linkFromFile(options)
			: await Zotero.Attachments.importFromFile(options);
		let identifying = (async () => {
			if (Zotero.RecognizeDocument.canRecognize(attachment)) {
				await Zotero.RecognizeDocument.recognizeItems([attachment]);
			}
			let parent = attachment.parentItem;
			await edit(clientID, async () => {
				if (parent) {
					Zotero.UndoHistory.stageCreation(parent);
				}
				Zotero.UndoHistory.stageCreation(attachment);
				if (title) {
					attachment.setField('title', title);
					await attachment.save();
				}
			});
			return parent || false;
		})();
		identifying.catch(e => Zotero.logError(e));
		let parent = await Promise.race([
			identifying,
			Zotero.Promise.delay(Math.max(0, deadline - Date.now())).then(() => null),
		]);
		let result = {
			libraryID,
			status: 'attached',
			...await describeAttachment(attachment),
			link: getOpenLink(attachment),
		};
		if (parent) {
			result.identified = 'yes';
			result.parent = await summarize(parent);
			result.parentKey = parent.key;
		}
		else if (parent === null) {
			result.identified = 'pending';
			result.notice = 'Zotero is still identifying the file. Call zotero_get_items on the '
				+ 'attachment later to see whether it has a parent item.';
		}
		else {
			result.identified = 'no';
			result.notice = Zotero.RecognizeDocument.canRecognize(attachment)
				? "Zotero couldn't identify the file, so it's a standalone attachment. If you know "
					+ 'what it is, add the item with zotero_add_items and attach the file to it.'
				: 'Zotero identifies only PDFs and EPUBs, so the file is a standalone attachment.';
		}
		return Zotero.MCP.jsonResult(result);
	}
	
	/**
	 * Import a file, or text, in a format Zotero imports, such as BibTeX, RIS or Zotero RDF,
	 * with the files a file refers to
	 *
	 * Translators save in their own transactions, so the new collections and items are made one
	 * undo step afterwards. An import still running at the call's deadline goes on in the
	 * background and becomes an undo step when it finishes.
	 */
	this.import = async function ({
		path, text, collectionKey, newCollection, linkFiles = false, libraryID,
	}, { clientID, deadline }) {
		libraryID = getLibraryID(libraryID);
		if (!path == !text?.trim()) {
			throw new Zotero.MCP.ToolError('Give path or text');
		}
		if (collectionKey && newCollection) {
			throw new Zotero.MCP.ToolError('Give collectionKey or newCollection, not both');
		}
		// Like File → Import, a file goes into a collection of its own
		newCollection ??= !!path && !collectionKey;
		let collections = collectionKey ? [getCollection(libraryID, collectionKey).id] : [];
		
		let translation = new Zotero.Translate.Import();
		let name;
		if (path) {
			let info = await statPath(path);
			if (info?.type != 'regular') {
				throw new Zotero.MCP.ToolError(`There's no file at ${path} on this computer.`);
			}
			translation.setLocation(Zotero.File.pathToFile(path));
			name = PathUtils.filename(path).replace(/\.[^.]*$/, '') || PathUtils.filename(path);
		}
		else {
			translation.setString(text);
			name = Zotero.getString('fileInterface.imported') + ' ' + new Date().toLocaleString();
		}
		let translators = await translation.getTranslators();
		if (!translators.length) {
			throw new Zotero.MCP.ToolError(
				`${path ? path + " isn't" : "text isn't"} in a format Zotero can import, such as `
					+ 'BibTeX, RIS, Zotero RDF or CSL JSON'
			);
		}
		translation.setTranslator(translators[0]);
		
		let created = null;
		if (newCollection) {
			if (Zotero.Collections.getByLibrary(libraryID).some(collection => collection.name == name)) {
				name += ' ' + new Date().toLocaleString();
			}
			created = new Zotero.Collection({ libraryID, name });
			await created.saveTx({ skipSelect: true });
			collections = [created.id];
		}
		let importing = translation.translate({
			libraryID,
			collections: collections.length ? collections : null,
			autoCreatedCollectionID: created?.id ?? null,
			linkFiles,
			// Text can't refer to files
			saveAttachments: !!path,
		}).then(async (items) => {
			await edit(clientID, async () => {
				for (let object of new Set([created, ...translation.newCollections ?? [], ...items])) {
					if (object) {
						Zotero.UndoHistory.stageCreation(object);
					}
				}
			});
			return items;
		});
		let items;
		try {
			items = await untilDeadline(importing, deadline);
		}
		catch (e) {
			if (created && !created.getChildItems(true).length) {
				await created.eraseTx();
			}
			throw new Zotero.MCP.ToolError(
				`Zotero couldn't import ${path || 'text'}: ${e.message || e}`
			);
		}
		if (items === TIMED_OUT) {
			return Zotero.MCP.jsonResult({
				libraryID,
				status: 'inProgress',
				collectionKey: created?.key ?? collectionKey,
				notice: 'Zotero is still importing. Call zotero_search on the collection later to '
					+ 'see the items.',
			});
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			status: 'imported',
			collectionKey: created?.key ?? collectionKey,
			itemCount: items.length,
			items: await Promise.all(items.slice(0, MAX_LISTED_ITEMS).map(summarize)),
		});
	};
	
	/**
	 * Items, a collection or a library in an export format, as text or written to a file, with
	 * the item's files beside it if asked
	 */
	this.export = async function ({
		format, keys, collectionKey, path, includeFiles = false, overwrite = false, libraryID,
	}, { deadline }) {
		libraryID = getLibraryID(libraryID);
		if (keys && collectionKey) {
			throw new Zotero.MCP.ToolError('Give keys or collectionKey, not both');
		}
		if (includeFiles && !path) {
			throw new Zotero.MCP.ToolError('includeFiles needs a path to write the files to');
		}
		let translator = await getExportTranslator(format);
		let translation = new Zotero.Translate.Export();
		let items;
		if (keys) {
			items = [];
			for (let key of new Set(keys)) {
				let item = await getItem(libraryID, key);
				if (item.isAnnotation()) {
					throw new Zotero.MCP.ToolError(
						`${key} is an annotation, which is exported with its file, not on its own`
					);
				}
				items.push(item);
			}
			translation.setItems(items);
		}
		else if (collectionKey) {
			let collection = getCollection(libraryID, collectionKey);
			translation.setCollection(collection);
			// With its subcollections' items, as Zotero.Translate.ItemGetter.setCollections() gets them
			items = [...new Set([collection, ...Zotero.Collections.getByParent(collection.id, true)]
				.flatMap(each => each.getChildItems()))];
		}
		else {
			translation.setLibraryID(libraryID);
			items = await Zotero.Items.getAll(libraryID, true);
		}
		translation.setTranslator(translator);
		
		let file;
		if (path) {
			let existing = await statPath(path);
			if (existing && (!overwrite || includeFiles || existing.type != 'regular')) {
				throw new Zotero.MCP.ToolError(
					!overwrite
						? `${path} already exists. Give another path, or overwrite: true to replace the file.`
						: `${path} already exists, and only a file can be overwritten, not a folder `
							+ 'or an export with its files.'
				);
			}
			if ((await statPath(PathUtils.parent(path)))?.type != 'directory') {
				throw new Zotero.MCP.ToolError(`There's no folder ${PathUtils.parent(path)} to write to.`);
			}
			translation.setLocation(Zotero.File.pathToFile(path));
			// With its files, the export is a folder named by the path, as with File → Export
			if (includeFiles) {
				translation.setDisplayOptions({
					...translator.displayOptions,
					exportFileData: true,
					includeAnnotations: true,
				});
				file = PathUtils.join(path, PathUtils.filename(path) + '.' + translator.target);
			}
			else {
				file = path;
			}
		}
		let exporting = new Promise((resolve, reject) => {
			translation.setHandler('done', (_, worked) => (worked ? resolve() : reject(new Error('Export failed'))));
			translation.setHandler('error', (_, error) => reject(error));
			translation.translate();
		});
		let result;
		try {
			result = await untilDeadline(exporting, deadline);
		}
		catch (e) {
			throw new Zotero.MCP.ToolError(`Zotero couldn't export: ${e.message || e}`);
		}
		if (path) {
			return Zotero.MCP.jsonResult({
				libraryID,
				format: translator.label,
				path: file,
				folder: includeFiles ? path : undefined,
				status: result === TIMED_OUT ? 'writing' : 'written',
				citationKeys: result === TIMED_OUT
					? undefined
					: getCitationKeys(translator, items, await IOUtils.readUTF8(file)),
			});
		}
		if (result === TIMED_OUT || translation.string.length > MAX_EXPORT_CHARS) {
			throw new Zotero.MCP.ToolError(
				'The export is too large to return. Give a path to write it to a file.'
			);
		}
		return Zotero.MCP.jsonResult({
			libraryID,
			format: translator.label,
			output: translation.string,
			citationKeys: getCitationKeys(translator, items, translation.string),
		});
	};
	
	/**
	 * The citation key each item got in a BibTeX or BibLaTeX export, which the translator
	 * makes up for items without one of their own
	 *
	 * The translators write an entry for each regular item, in the order Zotero gives them
	 * items in: by ID (Zotero.Translate.ItemGetter). Without as many entries as regular items,
	 * the keys can't be matched to items, so there are none.
	 *
	 * @param {Zotero.Item[]} items - The items exported
	 * @return {Object|undefined} Item keys to citation keys
	 */
	function getCitationKeys(translator, items, output) {
		if (![BIBTEX_TRANSLATOR_ID, BIBLATEX_TRANSLATOR_ID].includes(translator.translatorID)) {
			return undefined;
		}
		let regular = items.filter(item => item.isRegularItem()).sort((a, b) => a.id - b.id);
		let citationKeys = [...output.matchAll(/^@\w+\{([^,\s]*),/gm)].map(match => match[1]);
		if (regular.length > MAX_CITATION_KEYS || citationKeys.length != regular.length) {
			return undefined;
		}
		return Object.fromEntries(regular.map((item, i) => [item.key, citationKeys[i]]));
	}
	
	/**
	 * An export translator by its label, ignoring case, spaces and punctuation (e.g. "csljson"
	 * for CSL JSON), or by its ID
	 */
	async function getExportTranslator(format) {
		let normalize = label => label.toLowerCase().replace(/[^a-z0-9]/g, '');
		let translators = await Zotero.Translators.getAllForType('export');
		let translator = translators.find(
			translator => translator.translatorID == format || normalize(translator.label) == normalize(format)
		);
		if (!translator) {
			throw new Zotero.MCP.ToolError(
				`Zotero has no export format ${format}. Its formats are `
					+ translators.map(translator => translator.label).sort().join(', ') + '.'
			);
		}
		return translator;
	}
	
	/**
	 * @return {Promise<Object|null>} IOUtils.stat() of an absolute path, or null if there's
	 *     nothing there or it can't be read
	 * @throws {Zotero.MCP.ToolError} If the path isn't absolute
	 */
	async function statPath(path) {
		if (!PathUtils.isAbsolute(path)) {
			throw new Zotero.MCP.ToolError(`${path} isn't an absolute path. Give the full path.`);
		}
		try {
			return await IOUtils.stat(path);
		}
		catch {
			return null;
		}
	}
	
	/**
	 * A new item from item JSON, checked but not saved
	 *
	 * @param {String} input - Where the JSON is in the arguments, for errors
	 */
	function itemFromJSON(libraryID, data, input) {
		let json = { ...data };
		for (let property of EXISTING_ITEM_PROPERTIES) {
			delete json[property];
		}
		if (['note', 'attachment', 'annotation'].includes(json.itemType)) {
			throw new Zotero.MCP.ToolError(
				`${input}: ${json.itemType}s can't be added as items. Use zotero_add_note or `
					+ 'zotero_add_attachment.'
			);
		}
		let item = new Zotero.Item();
		item.libraryID = libraryID;
		try {
			item.fromJSON(json, { strict: true });
		}
		catch (e) {
			throw new Zotero.MCP.ToolError(`${input}: ${e.message}`);
		}
		return item;
	}
	
	/**
	 * Identifiers in a string, as in Add Item by Identifier, also from PubMed URLs, whose
	 * IDs extractIdentifiers() doesn't take after a slash
	 *
	 * @return {Object[]} e.g. [{ DOI: '10.1000/xyz' }]
	 */
	function extractIdentifiers(text) {
		text = text.replace(/^https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)\/?$/i, '$1');
		return Zotero.Utilities.extractIdentifiers(text);
	}
	
	/**
	 * An installed style, or one installed from the Zotero Style Repository with the user's
	 * permission
	 *
	 * @param {String} id - A style ID, a short name (e.g. "apa") or a repository URL
	 * @param {Object} call - The tool call's context, to ask for permission with and for its
	 *     deadline
	 */
	async function getStyle(id, call) {
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
			xml = (await Zotero.HTTP.request('GET', url, {
				responseType: 'text',
				timeout: Math.max(1, call.deadline - Date.now()),
				// Not retried after an error, which can take minutes
				errorDelayMax: 0,
			})).response;
		}
		catch (e) {
			if (e instanceof Zotero.HTTP.TimeoutException) {
				throw new Zotero.MCP.ToolError("The Zotero Style Repository didn't respond in time. Try again later.");
			}
			if (e instanceof Zotero.HTTP.UnexpectedStatusException && e.status == 404) {
				throw new Zotero.MCP.ToolError(
					`No style "${shortName}" in the Zotero Style Repository. Find style names at `
						+ STYLE_REPOSITORY
				);
			}
			throw e;
		}
		await Zotero.MCP.Permissions.require(call.clientID, Zotero.MCP.Permissions.INSTALL_STYLES, null, call);
		// Fetches the parent of a dependent style
		let installed = await untilDeadline(Zotero.Styles.install({ string: xml }, url, true), call.deadline);
		if (installed === TIMED_OUT) {
			throw new Zotero.MCP.ToolError('Zotero is still installing the style. Try again shortly.');
		}
		return Zotero.Styles.get(installed.styleID);
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
	 * @param {Number} deadline - Date.now() time to stop waiting for indexing at
	 * @return {Promise<String|null|Symbol>} Null if there's no text, or the file is missing;
	 *     TIMED_OUT if indexing didn't finish by the deadline
	 */
	async function getIndexedText(attachment, deadline) {
		if (!Zotero.FullText.isCachedMIMEType(attachment.attachmentContentType)) {
			let path = await attachment.getFilePathAsync();
			return path ? Zotero.File.getContentsAsync(path, attachment.attachmentCharset) : null;
		}
		let path = Zotero.FullText.getItemCacheFile(attachment).path;
		if (!await IOUtils.exists(path) && await attachment.fileExists()
				&& await untilDeadline(Zotero.FullText.indexItems([attachment.id]), deadline) === TIMED_OUT) {
			return TIMED_OUT;
		}
		return await IOUtils.exists(path) ? Zotero.File.getContentsAsync(path) : null;
	}
	
	/**
	 * Text of PDF pages, from the file
	 *
	 * @param {Integer[]} pageIndexes - Consecutive
	 * @param {Number} deadline - Date.now() time to stop waiting at
	 * @return {Promise<Object|Symbol>} { texts, totalPages }, with texts in the order of
	 *     pageIndexes, or TIMED_OUT
	 */
	async function extractPages(attachment, pageIndexes, deadline) {
		let result = await untilDeadline(Zotero.PDFWorker.getFullText(attachment.id, pageIndexes, true), deadline);
		if (result === TIMED_OUT) {
			return result;
		}
		return { texts: result.text.split('\f'), totalPages: result.totalPages };
	}
	
	/**
	 * The promise's value, or TIMED_OUT if the deadline comes first. The work goes on, and an
	 * error after the deadline is logged.
	 *
	 * @param {Number} deadline - Date.now() time to stop waiting at
	 */
	async function untilDeadline(promise, deadline) {
		let timedOut = false;
		promise.catch((e) => {
			if (timedOut) {
				Zotero.logError(e);
			}
		});
		let result = await Promise.race([
			promise,
			Zotero.Promise.delay(Math.max(0, deadline - Date.now())).then(() => TIMED_OUT),
		]);
		timedOut = result === TIMED_OUT;
		return result;
	}
	
	/**
	 * A PDF's page labels (the page numbers printed on its pages) and outline, from its
	 * structured document text (see sdt.js)
	 *
	 * The text itself comes from the full-text index, which works even when only text synced
	 * from another computer is here; structured document text is only for what the index
	 * doesn't have. Like Read Aloud, it's generated if it isn't cached, at the front of the PDF
	 * worker's queue. That takes about 25 ms a page, but the worker runs one job at a time,
	 * and the call has to finish by its deadline, so it's waited for only until the deadline.
	 * Generation goes on after that, so a later call has it.
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
			path: attachment.getFilePath() || undefined,
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
	
	/**
	 * A main window by its ID, or the one with a tab
	 *
	 * @param {String} [windowID]
	 * @param {String} [tabID]
	 * @return {ChromeWindow|null} Null if neither is given
	 */
	function getMainWindow(windowID, tabID) {
		let windows = Zotero.getMainWindows().filter(win => win.Zotero_Tabs);
		if (windowID) {
			let win = windows.find(win => win.Zotero_Tabs.windowID == windowID);
			if (!win) {
				throw new Zotero.MCP.ToolError(
					`No window ${windowID}. zotero_get_context lists Zotero's windows.`
				);
			}
			if (tabID && !getTabIDs(win).includes(tabID)) {
				throw new Zotero.MCP.ToolError(`${tabID} isn't a tab of window ${windowID}`);
			}
			return win;
		}
		if (tabID) {
			let win = windows.find(win => getTabIDs(win).includes(tabID));
			if (!win) {
				throw new Zotero.MCP.ToolError(`No tab ${tabID}. zotero_get_context lists Zotero's tabs.`);
			}
			return win;
		}
		return null;
	}
	
	/**
	 * @throws {Zotero.MCP.ToolError} If arguments for where to show something conflict
	 */
	function checkWhere({ windowID, tabID, newWindow, newTab }) {
		if (newWindow && (windowID || tabID || newTab)) {
			throw new Zotero.MCP.ToolError(
				'newWindow opens a window of its own. Leave out windowID, tabID and newTab.'
			);
		}
		if (newTab && tabID) {
			throw new Zotero.MCP.ToolError('Give tabID or newTab, not both');
		}
	}
	
	/**
	 * The IDs of a main window's tabs, in order, or only of those showing an item
	 */
	function getTabIDs(win, item) {
		return win.Zotero_Tabs._tabs
			.filter(tab => !item || tab.data?.itemID === item.id)
			.map(tab => tab.id);
	}
	
	function describeTab(win, tabID) {
		let { Zotero_Tabs, ZoteroPane } = win;
		let info = Zotero_Tabs.getTabInfo(tabID);
		let tab = {
			tabID,
			type: Zotero_Tabs.parseTabType(info.type).tabContentType,
			title: info.title,
			selected: tabID == Zotero_Tabs.selectedID || undefined,
		};
		let item = info.data?.itemID && Zotero.Items.get(info.data.itemID);
		if (item) {
			Object.assign(tab, { libraryID: item.libraryID, key: item.key });
			let reader = Zotero.Reader.getByTabID(tabID);
			if (reader && item.isPDFAttachment()) {
				let { pageIndex } = getReaderState(reader);
				tab.page = Number.isInteger(pageIndex) ? pageIndex + 1 : undefined;
			}
		}
		let view = ZoteroPane.getLibraryView(tabID);
		if (view?.loaded) {
			let rows = view.getCollectionTreeRows();
			let row = rows.length == 1 ? rows[0] : null;
			Object.assign(tab, {
				libraryID: row?.ref.libraryID,
				collectionKey: row?.isCollection() ? row.ref.key : undefined,
				savedSearchKey: row?.isSearch() ? row.ref.key : undefined,
			});
		}
		return tab;
	}
	
	/**
	 * A library tab's view once it shows what it was opened with
	 *
	 * @param {String|null} tabID - Null for the library tab of a new window
	 * @param {Number} deadline - Date.now() time to stop waiting at
	 */
	async function waitForLibraryView(win, tabID, deadline) {
		let view;
		while (!(view = tabID ? win.ZoteroPane?.getLibraryView(tabID) : win.ZoteroPane?.libraryView)?.loaded) {
			if (win.closed || Date.now() > deadline) {
				throw new Error("Zotero's library tab didn't open in time");
			}
			await Zotero.Promise.delay(20);
		}
		await view.waitForLibraryTabState();
		return view;
	}
	
	function getLibraryID(libraryID = Zotero.Libraries.userLibraryID) {
		if (!Zotero.Libraries.exists(libraryID)) {
			throw new Zotero.MCP.ToolError(`No library ${libraryID}. zotero_status lists the libraries.`);
		}
		return libraryID;
	}
	
	/**
	 * The items a saved search shows, as in its view: top-level, and not in the trash
	 */
	async function countSearchItems(search) {
		let items = await Zotero.Items.getAsync(await search.search());
		return Zotero.Items.getTopLevel(items).filter(item => !item.deleted).length;
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
			// For the AI app to open the file itself, e.g. to see a figure
			description.path = description.fileExists ? attachment.getFilePath() : undefined;
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
