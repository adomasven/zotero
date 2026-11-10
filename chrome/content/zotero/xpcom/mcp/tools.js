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
	
	// Zotero.Translate.Export translators for zotero_generate_citation's export formats
	const EXPORT_FORMATS = {
		bibtex: '9cb70025-a888-4a29-a210-93ec52da40d4',
		biblatex: 'b6e39b57-8942-4d11-8259-342c46ce395f',
		ris: '32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7',
		csljson: 'bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7',
	};
	
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
	
	// Removed in a later commit
	this.addTag = async function ({ itemKey, tag, libraryID = Zotero.Libraries.userLibraryID }) {
		if (!tag.trim()) {
			throw new Zotero.MCP.ToolError('tag must not be empty');
		}
		let item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
		if (!item || item.deleted) {
			throw new Zotero.MCP.ToolError(`No item ${itemKey} in library ${libraryID}`);
		}
		item.addTag(tag.trim());
		await item.saveTx();
		return Zotero.MCP.textResult(`Added tag "${tag.trim()}" to ${item.key}.`);
	};
};
