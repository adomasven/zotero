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
var { renderCell } = VirtualizedTable;

/**
 * One table of AI apps: supported apps found on this computer, which can be connected, and
 * any app that has used Zotero, which has permissions
 */
Zotero_Preferences.MCP = {
	_observers: [],
	_rows: [],
	_tree: null,
	_treePromise: null,
	_binaryInstalled: false,
	
	init() {
		this._observers.push(
			Zotero.Prefs.registerObserver('mcp.enabled', () => this.update()),
			Zotero.Prefs.registerObserver('mcp.clients', () => this.updateApps())
		);
		this.update();
	},
	
	uninit() {
		for (let symbol of this._observers) {
			Zotero.Prefs.unregisterObserver(symbol);
		}
		this._observers = [];
	},
	
	async update() {
		let enabled = Zotero.Prefs.get('mcp.enabled');
		document.getElementById('mcp-settings').hidden = !enabled;
		document.getElementById('mcp-server-disabled').hidden = !enabled
			|| Zotero.Prefs.get('httpServer.enabled');
		if (enabled) {
			await this.updateApps();
		}
	},
	
	enableServer() {
		Zotero.Prefs.set('httpServer.enabled', true);
		Zotero.Utilities.Internal.quit(true);
	},
	
	async updateApps() {
		let { Apps, AppConfig, Permissions } = Zotero.MCP;
		// Zotero installs the binary when MCP is turned on, which may still be running
		await Zotero.MCP.installPromise;
		this._binaryInstalled = await IOUtils.exists(Zotero.MCP.getBinaryPath());
		document.getElementById('mcp-binary-missing').hidden = this._binaryInstalled;
		
		let clients = Permissions.getClients();
		let rows = [];
		for (let app of Apps.getAll()) {
			// Apps Zotero only recognizes by name have no status
			let status = null;
			if (app.config) {
				try {
					status = await AppConfig.getStatus(app);
				}
				catch (e) {
					Zotero.logError(e);
					status = 'unreadable';
				}
			}
			let client = clients.find(client => client.app?.id == app.id);
			if ((!status || status == AppConfig.STATUS_NOT_INSTALLED) && !client) {
				continue;
			}
			rows.push({
				// Any of the app's names stands for the app, also before it first calls
				id: app.clientNames[0],
				used: !!client,
				app,
				name: app.name,
				icon: app.icon,
				status,
				lastSeen: client?.lastSeen,
			});
		}
		// Apps Zotero doesn't know, which were connected some other way
		for (let client of clients.filter(client => !client.app)) {
			rows.push({
				id: client.clientID,
				used: true,
				app: null,
				name: client.clientID,
				icon: Apps.UNKNOWN_ICON,
				status: null,
				lastSeen: client.lastSeen,
			});
		}
		
		let selectedID = this._getSelectedRow()?.id;
		this._rows = rows;
		await this._initTree();
		this._tree.invalidate();
		let index = rows.findIndex(row => row.id == selectedID);
		if (index == -1) {
			this._tree.selection.clearSelection();
		}
		else {
			this._tree.selection.select(index);
		}
		this.updateButtons();
	},
	
	_initTree() {
		this._treePromise ??= this._renderTree();
		return this._treePromise;
	},
	
	async _renderTree() {
		let columns = [
			{
				dataKey: 'name',
				label: 'preferences-mcp-column-app',
				flex: 2,
				renderCell: (index, name, column) => {
					let cell = renderCell(index, '', { className: column.className });
					let icon = document.createElement('img');
					icon.className = 'mcp-app-icon';
					icon.src = this._rows[index].icon;
					icon.alt = '';
					let text = document.createElement('span');
					text.className = 'cell-text';
					text.textContent = name;
					cell.append(icon, text);
					return cell;
				},
			},
			{
				dataKey: 'status',
				label: 'preferences-mcp-column-status',
				flex: 2,
				renderCell: (index, status, column) => {
					let row = this._rows[index];
					let cell = renderCell(index, '', { className: column.className });
					if (!status) {
						return cell;
					}
					let icon = document.createElement('span');
					icon.className = `mcp-status-icon mcp-status-${status}`;
					let text = document.createElement('span');
					text.className = 'cell-text';
					text.textContent = Zotero.ftl.formatValueSync(`preferences-mcp-app-${status}`);
					cell.append(icon, text);
					if (status == Zotero.MCP.AppConfig.STATUS_CONFLICT) {
						cell.title = Zotero.ftl.formatValueSync('preferences-mcp-app-conflict-tooltip', { app: row.name });
					}
					return cell;
				},
			},
			{
				dataKey: 'lastSeen',
				label: 'preferences-mcp-column-last-used',
				flex: 1,
				renderCell: (index, lastSeen, column) => renderCell(
					index,
					lastSeen
						? new Date(lastSeen).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
						: Zotero.ftl.formatValueSync('preferences-mcp-app-never-used'),
					{ className: column.className }
				),
			},
		];
		await new Promise((resolve) => {
			ReactDOM.createRoot(document.getElementById('mcp-apps')).render(
				<VirtualizedTable
					getRowCount={() => this._rows.length}
					id="mcp-apps-table"
					ref={(ref) => {
						this._tree = ref;
						resolve();
					}}
					renderItem={VirtualizedTable.makeRowRenderer(index => this._rows[index])}
					showHeader={true}
					columns={columns}
					staticColumns={true}
					disableFontSizeScaling={true}
					onSelectionChange={() => this.updateButtons()}
					onActivate={() => this.openPermissions()}
					getRowString={index => this._rows[index].name}
				/>
			);
		});
	},
	
	_getSelectedRow() {
		if (!this._tree || this._tree.selection.count != 1) {
			return null;
		}
		return this._rows[this._tree.selection.focused] || null;
	},
	
	updateButtons() {
		let { AppConfig } = Zotero.MCP;
		let row = this._getSelectedRow();
		let connect = document.getElementById('mcp-connect');
		let connected = row?.status == AppConfig.STATUS_CONNECTED;
		document.l10n.setAttributes(connect, connected ? 'preferences-mcp-disconnect' : 'preferences-mcp-connect');
		connect.disabled = !(connected || row?.status == AppConfig.STATUS_NOT_CONNECTED && this._binaryInstalled);
		document.getElementById('mcp-permissions').disabled = !row;
		document.getElementById('mcp-forget').disabled = !row?.used;
	},
	
	async toggleConnection() {
		let { AppConfig } = Zotero.MCP;
		let row = this._getSelectedRow();
		if (!row?.app) return;
		let path = await AppConfig.getConfigPath(row.app);
		let button = document.getElementById('mcp-connect');
		button.disabled = true;
		try {
			if (row.status == AppConfig.STATUS_CONNECTED) {
				await AppConfig.disconnect(row.app);
			}
			else {
				await AppConfig.connect(row.app);
			}
		}
		catch (e) {
			Zotero.logError(e);
			Zotero.alert(
				window,
				Zotero.ftl.formatValueSync('general-error'),
				Zotero.ftl.formatValueSync('preferences-mcp-config-error', {
					app: row.app.name,
					path,
				})
			);
		}
		await this.updateApps();
	},
	
	openPermissions() {
		let row = this._getSelectedRow();
		if (row) {
			Zotero.MCP.openPermissionsWindow(row.id, window);
		}
	},
	
	forgetSelected() {
		let row = this._getSelectedRow();
		// Updates the table through the pref observer
		if (row?.used) {
			Zotero.MCP.Permissions.forgetClient(row.id);
		}
	},
};
