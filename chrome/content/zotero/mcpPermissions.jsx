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

"use strict";

var React = require('react');
var ReactDOM = require('react-dom');
var VirtualizedTable = require('components/virtualized-table');
var { renderCell, renderCheckboxCell } = VirtualizedTable;

/**
 * window.arguments[0]: { clientID }
 *
 * Unchecked permissions aren't denied: Zotero asks when the app needs them.
 */
var Zotero_MCP_Permissions = { // eslint-disable-line no-unused-vars
	clientID: null,
	_observer: null,
	_rows: [],
	_tree: null,
	
	async init() {
		this.clientID = window.arguments[0].clientID;
		let title = { app: Zotero.MCP.Apps.getDisplayName(this.clientID) };
		document.l10n.setAttributes(document.documentElement, 'mcp-permissions-window', title);
		document.l10n.setAttributes(document.getElementById('mcp-permissions-heading'), 'mcp-permissions-heading', title);
		document.getElementById('mcp-permissions-settings').addEventListener('command', (event) => {
			this.setAllowed(Zotero.MCP.Permissions.EDIT_SETTINGS, null, event.target.checked);
		});
		await this._initTree();
		// Grants also change from consent dialogs while the window is open
		this._observer = Zotero.Prefs.registerObserver('mcp.clients', () => this.update());
		this.update();
	},
	
	uninit() {
		Zotero.Prefs.unregisterObserver(this._observer);
	},
	
	update() {
		let { Permissions } = Zotero.MCP;
		let grants = Permissions.getGrants(this.clientID);
		let find = (permission, libraryID) => grants.find(
			grant => grant.permission == permission && grant.libraryID == libraryID
		);
		this._rows = Zotero.Libraries.getAll()
			.filter(library => ['user', 'group'].includes(library.libraryType) && library.editable)
			.map(({ libraryID, name }) => ({
				libraryID,
				name,
				edit: !!find(Permissions.EDIT_LIBRARY, libraryID),
				deleteUntil: find(Permissions.DELETE, libraryID)?.until ?? null,
			}));
		this._tree.invalidate();
		this._fitTable();
		document.getElementById('mcp-permissions-settings').checked
			= !!find(Permissions.EDIT_SETTINGS, null);
	},
	
	/**
	 * Make the table tall enough for its rows, up to MAX_VISIBLE_ROWS, and the window fit it
	 */
	_fitTable() {
		const MAX_VISIBLE_ROWS = 8;
		let body = document.querySelector('#mcp-permissions-libraries-table .virtualized-table-body');
		let height = Math.min(this._rows.length, MAX_VISIBLE_ROWS) * this._tree._rowHeight + 'px';
		if (body.style.minHeight != height) {
			body.style.minHeight = height;
			this._tree.rerender();
			window.sizeToContent();
		}
	},
	
	async _initTree() {
		let checkboxColumn = (dataKey, label, permission) => ({
			dataKey,
			label,
			fixedWidth: true,
			width: 130,
			renderCell: (index, data, column) => {
				let row = this._rows[index];
				let checked = permission == Zotero.MCP.Permissions.DELETE ? !!row.deleteUntil : row.edit;
				let cell = renderCheckboxCell(index, checked, { className: column.className });
				if (checked && row.deleteUntil && permission == Zotero.MCP.Permissions.DELETE) {
					let until = document.createElement('span');
					until.className = 'mcp-delete-until';
					until.textContent = Zotero.ftl.formatValueSync('mcp-permissions-allowed-until', {
						time: new Date(row.deleteUntil).toLocaleTimeString([], { timeStyle: 'short' }),
					});
					cell.append(until);
				}
				cell.dataset.permission = permission;
				cell.style.pointerEvents = 'initial';
				cell.addEventListener('mousedown', () => this.toggle(index, permission));
				return cell;
			},
		});
		let columns = [
			{
				dataKey: 'name',
				label: 'mcp-permissions-library',
				renderCell: (index, name, column) => renderCell(index, name, { className: column.className }),
			},
			checkboxColumn('edit', 'mcp-permissions-edit', Zotero.MCP.Permissions.EDIT_LIBRARY),
			checkboxColumn('deleteUntil', 'mcp-permissions-delete', Zotero.MCP.Permissions.DELETE),
		];
		await new Promise((resolve) => {
			ReactDOM.createRoot(document.getElementById('mcp-permissions-libraries')).render(
				<VirtualizedTable
					getRowCount={() => this._rows.length}
					id="mcp-permissions-libraries-table"
					ref={(ref) => {
						this._tree = ref;
						resolve();
					}}
					renderItem={VirtualizedTable.makeRowRenderer(index => this._rows[index])}
					showHeader={true}
					columns={columns}
					staticColumns={true}
					disableFontSizeScaling={true}
					getRowString={index => this._rows[index].name}
					onKeyDown={(event) => {
						// Space toggles editing for the selected library
						if (event.key == ' ' && this._tree.selection.focused != -1) {
							this.toggle(this._tree.selection.focused, Zotero.MCP.Permissions.EDIT_LIBRARY);
							return false;
						}
						return true;
					}}
				/>
			);
		});
	},
	
	toggle(index, permission) {
		let row = this._rows[index];
		let allowed = permission == Zotero.MCP.Permissions.DELETE ? !!row.deleteUntil : row.edit;
		this.setAllowed(permission, row.libraryID, !allowed);
	},
	
	setAllowed(permission, libraryID, allowed) {
		let { Permissions } = Zotero.MCP;
		if (allowed) {
			// Like the consent dialog, moving to the trash is only allowed for an hour
			let until = permission == Permissions.DELETE ? Date.now() + Permissions.TEMPORARY_GRANT : null;
			Permissions.grant(this.clientID, permission, libraryID, until);
		}
		else {
			Permissions.revoke(this.clientID, permission, libraryID);
		}
	},
};
