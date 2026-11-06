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

Each takes the tool's arguments and a context ({ clientID }) and returns an MCP CallToolResult.
Permissions are declared in tools.json and checked before the handler runs (see mcp.js).
Throw Zotero.MCP.ToolError for errors the model should see, such as invalid arguments; other
errors are logged and reported to the model by message.

*/

Zotero.MCP.Tools = {
	status: async function (_args, { clientID }) {
		let libraries = Zotero.Libraries.getAll().map(library => ({
			libraryID: library.libraryID,
			type: library.libraryType,
			name: library.name,
			editable: library.editable,
		}));
		return Zotero.MCP.textResult(JSON.stringify({
			zoteroVersion: Zotero.version,
			client: clientID,
			libraries,
			// Reading needs no permission. Other actions ask the user unless granted here.
			permissions: Zotero.MCP.Permissions.getGrants(clientID),
		}, null, '\t'));
	},
	
	searchItems: async function ({ query, limit = 20 }) {
		if (typeof query != 'string' || !query.trim()) {
			throw new Zotero.MCP.ToolError('query must be a non-empty string');
		}
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
			throw new Zotero.MCP.ToolError('limit must be an integer from 1 to 50');
		}
		let search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition('quicksearch-titleCreatorYear', 'contains', query);
		let items = await Zotero.Items.getAsync(await search.search());
		items = items.filter(item => item.isRegularItem() && !item.deleted).slice(0, limit);
		if (!items.length) {
			return Zotero.MCP.textResult(`No items match "${query}".`);
		}
		let lines = items.map((item) => {
			let year = item.getField('year');
			let creator = item.getField('firstCreator');
			let byline = [creator, year].filter(Boolean).join(', ');
			return `${item.key}: ${item.getDisplayTitle()}${byline ? ` (${byline})` : ''}`;
		});
		return Zotero.MCP.textResult(lines.join('\n'));
	},
	
	addTag: async function ({ itemKey, tag, libraryID = Zotero.Libraries.userLibraryID }) {
		if (typeof tag != 'string' || !tag.trim()) {
			throw new Zotero.MCP.ToolError('tag must be a non-empty string');
		}
		let item = typeof itemKey == 'string' && Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
		if (!item || item.deleted) {
			throw new Zotero.MCP.ToolError(`No item ${itemKey} in library ${libraryID}`);
		}
		item.addTag(tag.trim());
		await item.saveTx();
		return Zotero.MCP.textResult(`Added tag "${tag.trim()}" to ${item.key}.`);
	},
};
