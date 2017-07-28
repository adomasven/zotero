/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2017 Center for History and New Media
					George Mason University, Fairfax, Virginia, USA
					http://zotero.org
	
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


/**
 * Orchestrates observers for various events relevant to the connector
 */
Zotero.ConnectorNotifier = {
	_listeners: [],
	_notifierID: null,

	init: function() {
		this._notifierID = Zotero.Notifier.registerObserver(this, ['collectionTreeRow', 'item'], 'Connector Notifier')
	},
	
	notify: function(event, targetType, ids, extraData) {
		if (event === 'select') {
			switch (targetType) {
				case 'item':
					this._notifySelectItem(ids);
					break;
				case 'collectionTreeRow':
					this._notifySelectCollection(ids);
					break;
			}
		}
	},
	
	_notifySelectItem: function(ids) {
		let items = Zotero.Items.get(ids);
		this.notifyListeners('select', {items: items.map((i) => ({itemID: i.itemID, title: i.getDisplayTitle()}))})
	},
	
	_notifySelectCollection: function() {
		var zp = Zotero.getActiveZoteroPane();
		var libraryID = zp.getSelectedLibraryID();
		var collection = zp.getSelectedCollection();
		let data = {collection: {id: collection.id, name: collection.name}};
		if (libraryID) {
			let library = Zotero.Libraries.get(libraryID);
			data.library = {name: library.name, id: libraryID};
		}
		this.notifyListeners('select', data)
	},
	
	notifyListeners: function(event, data) {
		this._listeners.forEach(function(listener) {
			listener.notify(event, data);
		});
	},

	addListener: function(listener) {
		this._listeners.push(listener);
		Zotero.debug(`ConnectorNotifier listener added. Total: ${this._listeners.length}`);
	},
	
	removeListener: function(listener) {
		this._listeners = this._listeners.filter((l) => l !== listener);
		Zotero.debug(`ConnectorNotifier listener removed. Total: ${this._listeners.length}`);
	},
};
