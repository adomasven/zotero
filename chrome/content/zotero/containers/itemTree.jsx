/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2019 Center for History and New Media
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

(function () {
const React = require('react');
const ReactDom = require('react-dom');
const { div } = require('react-dom-factories');
const PropTypes = require('prop-types');
const { IntlProvider } = require('react-intl');
const VirtualizedTable = require('components/virtualized-table');
const Icons = require('components/icons');
const getDomIcon = Icons.getDomElement;
const { getDragTargetOrient } = require('components/utils');
const cx = require('classnames');

const CHILD_INDENT = 20;
const COLUMNS = [
	{
		dataKey: "title",
		primary: true,
		defaultIn: new Set(["default", "feed"]),
		label: "zotero.items.title_column",
		ignoreInColumnPicker: "true",
		flex: "4",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "firstCreator",
		defaultIn: new Set(["default", "feed"]),
		label: "zotero.items.creator_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "itemType",
		label: "zotero.items.type_column",
		width: "40",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "date",
		defaultIn: new Set(["feed"]),
		label: "zotero.items.date_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "year",
		disabledIn: "feed",
		label: "zotero.items.year_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "publisher",
		label: "zotero.items.publisher_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "publicationTitle",
		disabledIn: "feed",
		label: "zotero.items.publication_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "journalAbbreviation",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.journalAbbr_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "language",
		submenu: "true",
		label: "zotero.items.language_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "accessDate",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.accessDate_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "libraryCatalog",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.libraryCatalog_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "callNumber",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.callNumber_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "rights",
		submenu: "true",
		label: "zotero.items.rights_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "dateAdded",
		disabledIn: "feed",
		label: "zotero.items.dateAdded_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "dateModified",
		disabledIn: "feed",
		label: "zotero.items.dateModified_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "archive",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.archive_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "archiveLocation",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.archiveLocation_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "place",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.place_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "volume",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.volume_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "edition",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.edition_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "pages",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.pages_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "issue",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.issue_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "series",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.series_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "seriesTitle",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.seriesTitle_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "court",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.court_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "medium",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.medium_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "genre",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.genre_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "system",
		disabledIn: "feed",
		submenu: "true",
		label: "zotero.items.system_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "extra",
		disabledIn: "feed",
		label: "zotero.items.extra_column",
		flex: "1",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "hasAttachment",
		defaultIn: new Set(["default"]),
		disabledIn: "feed",
		class: "treecol-image",
		label: "zotero.tabs.attachments.label",
		fixed: "true",
		zoteroPersist: "ordinal hidden sortActive sortDirection",
	},
	{
		dataKey: "numNotes",
		disabledIn: "feed",
		class: "treecol-image",
		label: "zotero.tabs.notes.label",
		zoteroPersist: "width ordinal hidden sortActive sortDirection",
	}
];

function makeItemRenderer(itemTree) {
	function renderPrimaryCell(index, label, column) {
		let span = renderCell(index, label, column);
		let icon = itemTree._getIcon(index);
		let arrow = getDomIcon("IconTwisty");
		arrow.classList.add('arrow');
		span.prepend(arrow, icon);
		span.classList.add('primary');
		return span;
	}
	
	function renderCell(index, label, column) {
		let span = document.createElementNS("http://www.w3.org/1999/xhtml", 'span');
		span.className = `cell ${column.className}`;
		span.innerText = label;
		return span;
	}
	
	return function (index, selection) {
		let rowData = itemTree._getRowData({ index });
		let div = document.createElementNS("http://www.w3.org/1999/xhtml", 'div');
		div.className = "row";
		if (selection.isSelected(index)) {
			div.classList.add('selected');
		}
		
		for (let column of itemTree._columns) {
			if (column.hidden) continue;
			
			if (column.primary) {
				div.appendChild(renderPrimaryCell(index, rowData[column.dataKey], column));
			}
			else {
				div.appendChild(renderCell(index, rowData[column.dataKey], column));
			}
		}
		
		return div;
	};
}

Zotero.ItemTree = class ItemTree extends React.Component {
	static init(domEl, opts={}) {
		Zotero.debug("Initializing React ItemTree");
		var ref;
		opts.domEl = domEl;
		let elem = (
			<IntlProvider locale={Zotero.locale} messages={Zotero.Intl.strings}>
				<ItemTree ref={c => ref = c } {...opts} />
			</IntlProvider>
		);
		ReactDom.render(elem, domEl);
		
		return ref;
	}
	
	constructor(props) {
		super(props);
		
		this.id = "item-tree-" + Zotero.Utilities.randomString(5);
		this._rows = [];
		this._rowMap = {};
		
		this.domEl = props.domEl;
		this.collectionTreeRow = props.collectionTreeRow;
		this.collapseAll = true;
		
		this._skipKeypress = false;
		
		this._ownerDocument = null;
		this._needsSort = false;
		this._introText = null;
		
		this._rowCache = {};
		this._itemImages = {};
		
		this._refreshPromise = Zotero.Promise.resolve();
		
		this._unregisterID = Zotero.Notifier.registerObserver(
			this,
			['item', 'collection-item', 'item-tag', 'share-items', 'bucket', 'feedItem', 'search'],
			'itemTreeView',
			50
		);
		
		if (this.collectionTreeRow) {
			this.collectionTreeRow.view.itemTreeView = this;
		}
		
		this.renderItem = makeItemRenderer(this);

		this.onLoad = this._createEventBinding('load', true, true);
		this.onSelect = this._createEventBinding('select');
		this.onRefresh = this._createEventBinding('refresh');


		this._initializeColumnStyleMap();
	}
	
	_initializeColumnStyleMap() {
		this._cssSuffix = '-' + Zotero.Utilities.randomString(5);
		
		this._stylesheet = document.createElementNS("http://www.w3.org/1999/xhtml", 'style');
		this._columnStyleMap = {};
		document.children[0].appendChild(this._stylesheet);
		for (let i = 0; i < COLUMNS.length; i++) {
			let column = COLUMNS[i];
			this._stylesheet.sheet.insertRule(`.${column.dataKey + this._cssSuffix} {flex-basis: 100px}`, i);
			this._columnStyleMap[column.dataKey] = [i, column.dataKey + this._cssSuffix];
		}
	}
	
	componentDidCatch(error, info) {
		Zotero.debug("ItemTree: React threw an error");
		Zotero.debug(error);
		Zotero.debug(info);
		Zotero.Prefs.clear('lastViewedFolder');
		// TODO:
		ZoteroPane.displayErrorMessage();
	}
	
	async makeVisible() {
		try {
			// if (this._treebox) {
			// 	if (this._needsSort) {
			// 		this.sort();
			// 	}
			// 	return;
			// }
			
			var start = Date.now();
			
			Zotero.debug("Setting tree for " + this.collectionTreeRow.id + " items view " + this.id);
			
			// if (!treebox) {
			// 	Zotero.debug("Treebox not passed in setTree()", 2);
			// 	return;
			// }
			// this._treebox = treebox;
			
			// if (!this._ownerDocument) {
			// 	try {
			// 		this._ownerDocument = treebox.treeBody.ownerDocument;
			// 	}
			// 	catch (e) {}
			//	
			// 	if (!this._ownerDocument) {
			// 		Zotero.debug("No owner document in setTree()", 2);
			// 		return;
			// 	}
			// }
			
			// this.setSortColumn();
			
			// if (this.window.ZoteroPane) {
			// 	this.window.ZoteroPane.setItemsPaneMessage(Zotero.getString('pane.items.loading'));
			// }
			
			// if (Zotero.locked) {
			// 	Zotero.debug("Zotero is locked -- not loading items tree", 2);
			//	
			// 	if (this.window.ZoteroPane) {
			// 		this.window.ZoteroPane.clearItemsPaneMessage();
			// 	}
			// 	return;
			// }
			
			// Don't expand to show search matches in My Publications
			var skipExpandMatchParents = this.collectionTreeRow.isPublications();
			
			// await this.refresh(skipExpandMatchParents);
			// if (!this._treebox.treeBody) {
			// 	return;
			// }
			
			// Expand all parent items in the view, regardless of search matches. We do this here instead
			// of refresh so that it doesn't get reverted after item changes.
			// if (this.expandAll) {
			// 	var t = new Date();
			// 	for (let i = 0; i < this._rows.length; i++) {
			// 		if (this.isContainer(i) && !this.isContainerOpen(i)) {
			// 			this.toggleOpenState(i, true);
			// 		}
			// 	}
			// 	Zotero.debug(`Opened all parent items in ${new Date() - t} ms`);
			// }
			// this._refreshItemRowMap();
			
			// Add a keypress listener for expand/collapse
			// var tree = this._getTreeElement();
			// var self = this;
			// var coloredTagsRE = new RegExp("^[1-" + Zotero.Tags.MAX_COLORED_TAGS + "]{1}$");
			// var listener = function(event) {
			// 	if (self._skipKeyPress) {
			// 		self._skipKeyPress = false;
			// 		return;
			// 	}
			//	
			// 	// Handle arrow keys specially on multiple selection, since
			// 	// otherwise the tree just applies it to the last-selected row
			// 	if (event.keyCode == event.DOM_VK_RIGHT || event.keyCode == event.DOM_VK_LEFT) {
			// 		if (self._treebox.view.selection.count > 1) {
			// 			switch (event.keyCode) {
			// 				case event.DOM_VK_RIGHT:
			// 					self.expandSelectedRows();
			// 					break;
			//					
			// 				case event.DOM_VK_LEFT:
			// 					self.collapseSelectedRows();
			// 					break;
			// 			}
			//			
			// 			event.preventDefault();
			// 		}
			// 		return;
			// 	}
			//	
			// 	var key = String.fromCharCode(event.which);
			// 	if (key == '+' && !(event.ctrlKey || event.altKey || event.metaKey)) {
			// 		self.expandAllRows();
			// 		event.preventDefault();
			// 		return;
			// 	}
			// 	else if (key == '-' && !(event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) {
			// 		self.collapseAllRows();
			// 		event.preventDefault();
			// 		return;
			// 	}
			//	
			// 	// Ignore other non-character keypresses
			// 	if (!event.charCode || event.shiftKey || event.ctrlKey ||
			// 			event.altKey || event.metaKey) {
			// 		return;
			// 	}
			//	
			// 	event.preventDefault();
			// 	event.stopPropagation();
			//	
			// 	Zotero.spawn(function* () {
			// 		if (coloredTagsRE.test(key)) {
			// 			let libraryID = self.collectionTreeRow.ref.libraryID;
			// 			let position = parseInt(key) - 1;
			// 			let colorData = Zotero.Tags.getColorByPosition(libraryID, position);
			// 			// If a color isn't assigned to this number or any
			// 			// other numbers, allow key navigation
			// 			if (!colorData) {
			// 				return !Zotero.Tags.getColors(libraryID).size;
			// 			}
			//			
			// 			var items = self.getSelectedItems();
			// 			yield Zotero.Tags.toggleItemsListTags(libraryID, items, colorData.name);
			// 			return;
			// 		}
			//		
			// 		// We have to disable key navigation on the tree in order to
			// 		// keep it from acting on the 1-9 keys used for colored tags.
			// 		// To allow navigation with other keys, we temporarily enable
			// 		// key navigation and recreate the keyboard event. Since
			// 		// that will trigger this listener again, we set a flag to
			// 		// ignore the event, and then clear the flag above when the
			// 		// event comes in. I see no way this could go wrong...
			// 		tree.disableKeyNavigation = false;
			// 		self._skipKeyPress = true;
			// 		var nsIDWU = Components.interfaces.nsIDOMWindowUtils;
			// 		var domWindowUtils = event.originalTarget.ownerDocument.defaultView
			// 			.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
			// 			.getInterface(nsIDWU);
			// 		var modifiers = 0;
			// 		if (event.altKey) {
			// 			modifiers |= nsIDWU.MODIFIER_ALT;
			// 		}
			// 		if (event.ctrlKey) {
			// 			modifiers |= nsIDWU.MODIFIER_CONTROL;
			// 		}
			// 		if (event.shiftKey) {
			// 			modifiers |= nsIDWU.MODIFIER_SHIFT;
			// 		}
			// 		if (event.metaKey) {
			// 			modifiers |= nsIDWU.MODIFIER_META;
			// 		}
			// 		domWindowUtils.sendKeyEvent(
			// 			'keypress',
			// 			event.keyCode,
			// 			event.charCode,
			// 			modifiers
			// 		);
			// 		tree.disableKeyNavigation = true;
			// 	})
			// 	.catch(function (e) {
			// 		Zotero.logError(e);
			// 	})
			// }.bind(this);
			// // Store listener so we can call removeEventListener() in ItemTreeView.unregister()
			// this.listener = listener;
			// tree.addEventListener('keypress', listener);
			
			// // This seems to be the only way to prevent Enter/Return
			// // from toggle row open/close. The event is handled by
			// // handleKeyPress() in zoteroPane.js.
			// tree._handleEnter = function () {};
			//
			// this._updateIntroText();
			
			if (this.collectionTreeRow && this.collectionTreeRow.itemsToSelect) {
				await this.selectItems(this.collectionTreeRow.itemsToSelect);
				this.collectionTreeRow.itemsToSelect = null;
			}
			
			Zotero.debug("Set tree for items view " + this.id + " in " + (Date.now() - start) + " ms");
			
			this._initialized = true;
			await this.runListeners('load');
		}
		catch (e) {
			Zotero.debug(e, 1);
			Components.utils.reportError(e);
			if (this.onError) {
				this.onError(e);
			}
			throw e;
		}
	}
	
	refresh = Zotero.serial(async function (skipExpandMatchParents) {
		Zotero.debug('Refreshing items list for ' + this.id);
		
		// // DEBUG: necessary?
		// try {
		// 	this._treebox.columns.count
		// }
		// // If treebox isn't ready, skip refresh
		// catch (e) {
		// 	return false;
		// }
		
		var resolve, reject;
		this._refreshPromise = new Zotero.Promise(function () {
			resolve = arguments[0];
			reject = arguments[1];
		});
		
		try {
			Zotero.CollectionTreeCache.clear();
			// Get the full set of items we want to show
			let newSearchItems = await this.collectionTreeRow.getItems();
			// Remove notes and attachments if necessary
			if (this.regularOnly) {
				newSearchItems = newSearchItems.filter(item => item.isRegularItem());
			}
			let newSearchItemIDs = new Set(newSearchItems.map(item => item.id));
			// Find the items that aren't yet in the tree
			let itemsToAdd = newSearchItems.filter(item => this._rowMap[item.id] === undefined);
			// Find the parents of search matches
			let newSearchParentIDs = new Set(
				this.regularOnly
					? []
					: newSearchItems.filter(item => !!item.parentItemID).map(item => item.parentItemID)
			);
			newSearchItems = new Set(newSearchItems);
			
			// if (this.selection && !this.selection.selectEventsSuppressed) {
			// 	var unsuppress = this.selection.selectEventsSuppressed = true;
			// 	// this._treebox.beginUpdateBatch();
			// }
			var savedSelection = this.getSelectedItems(true);
			
			var newCellTextCache = {};
			var newSearchMode = this.collectionTreeRow.isSearchMode();
			var newRows = [];
			var allItemIDs = new Set();
			var addedItemIDs = new Set();
			
			// Copy old rows to new array, omitting top-level items not in the new set and their children
			//
			// This doesn't add new child items to open parents or remove child items that no longer exist,
			// which is done by toggling all open containers below.
			var skipChildren;
			for (let i = 0; i < this._rows.length; i++) {
				let row = this._rows[i];
				// Top-level items
				if (row.level == 0) {
					let isSearchParent = newSearchParentIDs.has(row.ref.id);
					// If not showing children or no children match the search, close
					if (this.regularOnly || !isSearchParent) {
						row.isOpen = false;
						skipChildren = true;
					}
					else {
						skipChildren = false;
					}
					// Skip items that don't match the search and don't have children that do
					if (!newSearchItems.has(row.ref) && !isSearchParent) {
						continue;
					}
				}
				// Child items
				else if (skipChildren) {
					continue;
				}
				newRows.push(row);
				allItemIDs.add(row.ref.id);
			}
			
			// Add new items
			for (let i = 0; i < itemsToAdd.length; i++) {
				let item = itemsToAdd[i];
				
				// If child item matches search and parent hasn't yet been added, add parent
				let parentItemID = item.parentItemID;
				if (parentItemID) {
					if (allItemIDs.has(parentItemID)) {
						continue;
					}
					item = Zotero.Items.get(parentItemID);
				}
				// Parent item may have already been added from child
				else if (allItemIDs.has(item.id)) {
					continue;
				}
				
				// Add new top-level items
				let row = new Zotero.ItemTreeRow(item, 0, false);
				newRows.push(row);
				allItemIDs.add(item.id);
				addedItemIDs.add(item.id);
			}
			
			this._rows = newRows;
			this._refreshItemRowMap();
			// Sort only the new items
			//
			// This still results in a lot of extra work (e.g., when clearing a quick search, we have to
			// re-sort all items that didn't match the search), so as a further optimization we could keep
			// a sorted list of items for a given column configuration and restore items from that.
			// this.sort([...addedItemIDs]);
			
			// Toggle all open containers closed and open to refresh child items
			//
			// This could be avoided by making sure that items in notify() that aren't present are always
			// added.
			var t = new Date();
			// for (let i = 0; i < this._rows.length; i++) {
			// 	if (this.isContainer(i) && this.isContainerOpen(i)) {
			// 		this.toggleOpenState(i, true);
			// 		this.toggleOpenState(i, true);
			// 	}
			// }
			Zotero.debug(`Refreshed open parents in ${new Date() - t} ms`);
			
			this._refreshItemRowMap();
			
			this._searchMode = newSearchMode;
			this._searchItemIDs = newSearchItemIDs; // items matching the search
			this._rowCache = {};
			
			// this.rememberSelection(savedSelection);
			// if (!skipExpandMatchParents) {
			// 	this.expandMatchParents(newSearchParentIDs);
			// }
			// if (unsuppress) {
			// 	// this._treebox.endUpdateBatch();
			// 	this.selection.selectEventsSuppressed = false;
			// }
			
			// Clear My Publications intro text on a refresh with items
			if (this.collectionTreeRow.isPublications() && this.rowCount) {
				// this.window.ZoteroPane.clearItemsPaneMessage();
			}
			
			await this.runListeners('refresh');
			
			setTimeout(function () {
				resolve();
			});
		}
		catch (e) {
			setTimeout(function () {
				reject(e);
			});
			throw e;
		}
	})
	
	render() {
		let itemHeight = 20; // px
		if (Zotero.isLinux) {
			itemHeight = 22;
		}
		itemHeight *= Zotero.Prefs.get('fontSize');

		if (!this.collectionTreeRow) {
			return div("LOADING");
		}

		ZoteroPane.clearItemsPaneMessage();
		return React.createElement(VirtualizedTable,
			{
				height: this.domEl.parentElement.clientHeight,
				container: this.domEl.parentElement,
				rowCount: this._rows.length,
				rowHeight: itemHeight,
				id: this.id,
				ref: ref => this.tree = ref,
				treeboxRef: ref => this._treebox = ref,
				columns: this._columns,
				renderItem: this.renderItem,
				
				multiSelect: true,
				
				// getAriaLabel: index => this.getRow(index).getName(),
				isSelectable: () => true,
				// isContainer: this.isContainer,
				// isContainerEmpty: this.isContainerEmpty,
				// isContainerOpen: this.isContainerOpen,
				// toggleOpenState: async (index) => {
				// 	await this.toggleOpenState(index);
				// 	this.forceUpdate();
				// },
				
				// onDragLeave: (e) => this.props.dragAndDrop && this.onTreeDragLeave(e),
				// onSelectionChange: this.handleSelectionChange,
				// onKeyDown: this.handleKeyDown,
				// onActivate: this.handleActivate,
				// onColumnPickerMenu: () => 0,
				onColumnResize: this._resizeColumns,
				onHeaderClick: this._handleHeaderClick,

				label: Zotero.getString('pane.collections.title'),
			}
		);
	}
	
	async changeCollectionTreeRow(collectionTreeRow, collapseAll=true) {
		this.collapseAll = collapseAll;
		// Items view column visibility for different groups
		let prevViewGroup = this.collectionTreeRow && this.collectionTreeRow.visibilityGroup;
		let curViewGroup = collectionTreeRow.visibilityGroup;
		if (prevViewGroup && curViewGroup != prevViewGroup) {
			this._storeColumnVisibility(prevViewGroup);
		}
		this.collectionTreeRow = collectionTreeRow;
		this.collectionTreeRow.view.itemTreeView = this;
		this._columns = this._getColumns();
		await this.refresh();
		this.forceUpdate(() => this.selection.select(0));
	}
	
	async selectItems(ids, noRecurse) {
		if (!ids.length) return 0;
		
		// If no row map, we're probably in the process of switching collections,
		// so store the items to select on the item group for later
		if (!this._rowMap) {
			if (this.collectionTreeRow) {
				this.collectionTreeRow.itemsToSelect = ids;
				Zotero.debug("_rowMap not yet set; not selecting items");
				return 0;
			}
			
			Zotero.debug('Item group not found and no row map in ItemTreeView.selectItem() -- discarding select', 2);
			return 0;
		}
		
		var idsToSelect = [];
		for (let id of ids) {
			let row = this._rowMap[id];
			let item = Zotero.Items.get(id);
			
			// Can't select a deleted item if we're not in the trash
			if (item.deleted && !this.collectionTreeRow.isTrash()) {
				continue;
			}
			
			// Get the row of the parent, if there is one
			let parent = item.parentItemID;
			let parentRow = parent && this._rowMap[parent];
			
			// If row with id isn't visible, check to see if it's hidden under a parent
			if (row == undefined) {
				if (!parent || parentRow === undefined) {
					// No parent -- it's not here
					
					// Clear the quick search and tag selection and try again (once)
					if (!noRecurse && this.window.ZoteroPane) {
						let cleared1 = await this.window.ZoteroPane.clearQuicksearch();
						let cleared2 = this.window.ZoteroPane.tagSelector
							&& this.window.ZoteroPane.tagSelector.clearTagSelection();
						if (cleared1 || cleared2) {
							return this.selectItems(ids, true);
						}
					}
					
					Zotero.debug(`Couldn't find row for item ${id} -- not selecting`);
					continue;
				}
				
				// If parent is already open and we haven't found the item, the child
				// hasn't yet been added to the view, so close parent to allow refresh
				// this._closeContainer(parentRow);
				
				// Open the parent
				// this.toggleOpenState(parentRow);
			}
			
			// Since we're opening containers, we still need to reference by id
			idsToSelect.push(id);
		}
		
		// Now that all items have been expanded, get associated rows
		var rowsToSelect = [];
		for (let id of idsToSelect) {
			let row = this._rowMap[id];
			rowsToSelect.push(row);
		}
		
		// If items are already selected, just scroll to the top-most one
		var selectedRows = this.selection.selected;
		if (rowsToSelect.length == selectedRows.size && rowsToSelect.every(row => selectedRows.has(row))) {
			// this.ensureRowsAreVisible(rowsToSelect);
			return rowsToSelect.length;
		}
		
		// Single item
		if (rowsToSelect.length == 1) {
			// this.selection.select() triggers the <tree>'s 'onselect' attribute, which calls
			// ZoteroPane.itemSelected(), which calls ZoteroItemPane.viewItem(), which refreshes the
			// itembox. But since the 'onselect' doesn't handle promises, itemSelected() isn't waited for
			// here, which means that 'yield selectItem(itemID)' continues before the itembox has been
			// refreshed. To get around this, we wait for a select event that's triggered by
			// itemSelected() when it's done.
			// let promise;
			// try {
			// 	if (!this.selection.selectEventsSuppressed) {
			// 		promise = this.waitForSelect();
			// 	}
			// 	this.selection.select(rowsToSelect[0]);
			// }
			// // Ignore NS_ERROR_UNEXPECTED from nsITreeSelection::select(), apparently when the tree
			// // disappears before it's called (though I can't reproduce it):
			// //
			// // https://forums.zotero.org/discussion/comment/297039/#Comment_297039
			// catch (e) {
			// 	Zotero.logError(e);
			// }
			//
			// if (promise) {
			// 	await promise;
			// }
		}
		// Multiple items
		else {
			this.selection.clearSelection();
			this.selection.selectEventsSuppressed = true;
			
			var lastStart = 0;
			for (let i = 0, len = rowsToSelect.length; i < len; i++) {
				if (i == len - 1 || rowsToSelect[i + 1] != rowsToSelect[i] + 1) {
					this.selection.rangedSelect(rowsToSelect[lastStart], rowsToSelect[i], true);
					lastStart = i + 1;
				}
			}
			
			this.selection.selectEventsSuppressed = false;
		}
		
		this.ensureRowsAreVisible(rowsToSelect);
		
		return rowsToSelect.length;
	}

	/*
	 *  Sort the items by the currently sorted column.
	 */
	sort(itemIDs) {
		var t = new Date;
		
		// For child items, just close and reopen parents
		if (itemIDs) {
			let parentItemIDs = new Set();
			let skipped = [];
			for (let itemID of itemIDs) {
				let row = this._rowMap[itemID];
				let item = this.getRow(row).ref;
				let parentItemID = item.parentItemID;
				if (!parentItemID) {
					skipped.push(itemID);
					continue;
				}
				parentItemIDs.add(parentItemID);
			}
			
			let parentRows = [...parentItemIDs].map(itemID => this._rowMap[itemID]);
			parentRows.sort();
			
			// for (let i = parentRows.length - 1; i >= 0; i--) {
			// 	let row = parentRows[i];
			// 	this._closeContainer(row, true);
			// 	this.toggleOpenState(row, true);
			// }
			this._refreshItemRowMap();
			
			let numSorted = itemIDs.length - skipped.length;
			if (numSorted) {
				Zotero.debug(`Sorted ${numSorted} child items by parent toggle`);
			}
			if (!skipped.length) {
				return;
			}
			itemIDs = skipped;
			if (numSorted) {
				Zotero.debug(`${itemIDs.length} items left to sort`);
			}
		}
		
		var primaryField = this._getSortField();
		var sortFields = this._getSortFields();
		var order = this._sortedColumn.sortDirection;
		var collation = Zotero.getLocaleCollation();
		var sortCreatorAsString = Zotero.Prefs.get('sortCreatorAsString');
		
		Zotero.debug(`Sorting items list by ${sortFields.join(", ")} ${order == 1 ? "ascending" : "descending"} `
			+ (itemIDs && itemIDs.length
				? `for ${itemIDs.length} ` + Zotero.Utilities.pluralize(itemIDs.length, ['item', 'items'])
				: ""));
		
		// Set whether rows with empty values should be displayed last,
		// which may be different for primary and secondary sorting.
		var emptyFirst = {};
		switch (primaryField) {
		case 'title':
			emptyFirst.title = true;
			break;
		
		// When sorting by title we want empty titles at the top, but if not
		// sorting by title, empty titles should sort to the bottom so that new
		// empty items don't get sorted to the middle of the items list.
		default:
			emptyFirst.title = false;
		}
		
		// Cache primary values while sorting, since base-field-mapped getField()
		// calls are relatively expensive
		var cache = {};
		sortFields.forEach(x => cache[x] = {});
		
		// Get the display field for a row (which might be a placeholder title)
		function getField(field, row) {
			var item = row.ref;
			
			switch (field) {
			case 'title':
				return Zotero.Items.getSortTitle(item.getDisplayTitle());
			
			case 'hasAttachment':
				if (item.isFileAttachment()) {
					var state = item.fileExistsCached() ? 1 : -1;
				}
				else if (item.isRegularItem()) {
					var state = item.getBestAttachmentStateCached();
				}
				else {
					return 0;
				}
				// Make sort order present, missing, empty when ascending
				if (state === 1) {
					state = 2;
				}
				else if (state === -1) {
					state = 1;
				}
				return state;
			
			case 'numNotes':
				return row.numNotes(false, true) || 0;
			
			// Use unformatted part of date strings (YYYY-MM-DD) for sorting
			case 'date':
				var val = row.ref.getField('date', true, true);
				if (val) {
					val = val.substr(0, 10);
					if (val.indexOf('0000') == 0) {
						val = "";
					}
				}
				return val;
			
			case 'year':
				var val = row.ref.getField('date', true, true);
				if (val) {
					val = val.substr(0, 4);
					if (val == '0000') {
						val = "";
					}
				}
				return val;
			
			default:
				return row.ref.getField(field, false, true);
			}
		}
		
		var includeTrashed = this.collectionTreeRow.isTrash();
		
		function fieldCompare(a, b, sortField) {
			var aItemID = a.id;
			var bItemID = b.id;
			var fieldA = cache[sortField][aItemID];
			var fieldB = cache[sortField][bItemID];
			
			switch (sortField) {
			case 'firstCreator':
				return creatorSort(a, b);
			
			case 'itemType':
				var typeA = Zotero.ItemTypes.getLocalizedString(a.ref.itemTypeID);
				var typeB = Zotero.ItemTypes.getLocalizedString(b.ref.itemTypeID);
				return (typeA > typeB) ? 1 : (typeA < typeB) ? -1 : 0;
				
			default:
				if (fieldA === undefined) {
					cache[sortField][aItemID] = fieldA = getField(sortField, a);
				}
				
				if (fieldB === undefined) {
					cache[sortField][bItemID] = fieldB = getField(sortField, b);
				}
				
				// Display rows with empty values last
				if (!emptyFirst[sortField]) {
					if(fieldA === '' && fieldB !== '') return 1;
					if(fieldA !== '' && fieldB === '') return -1;
				}
				
				if (sortField == 'hasAttachment') {
					return fieldB - fieldA;
				}
				
				return collation.compareString(1, fieldA, fieldB);
			}
		}
		
		var rowSort = function (a, b) {
			for (let i = 0; i < sortFields.length; i++) {
				let cmp = fieldCompare(a, b, sortFields[i]);
				if (cmp !== 0) {
					return cmp;
				}
			}
			return 0;
		};
		
		var creatorSortCache = {};
		
		// Regexp to extract the whole string up to an optional "and" or "et al."
		var andEtAlRegExp = new RegExp(
			// Extract the beginning of the string in non-greedy mode
			"^.+?"
			// up to either the end of the string, "et al." at the end of string
			+ "(?=(?: " + Zotero.getString('general.etAl').replace('.', '\.') + ")?$"
			// or ' and '
			+ "| " + Zotero.getString('general.and') + " "
			+ ")"
		);
		
		function creatorSort(a, b) {
			var itemA = a.ref;
			var itemB = b.ref;
			//
			// Try sorting by the first name in the firstCreator field, since we already have it
			//
			// For sortCreatorAsString mode, just use the whole string
			//
			var aItemID = a.id,
				bItemID = b.id,
				fieldA = creatorSortCache[aItemID],
				fieldB = creatorSortCache[bItemID];
			var prop = sortCreatorAsString ? 'firstCreator' : 'sortCreator';
			var sortStringA = itemA[prop];
			var sortStringB = itemB[prop];
			if (fieldA === undefined) {
				let firstCreator = Zotero.Items.getSortTitle(sortStringA);
				if (sortCreatorAsString) {
					var fieldA = firstCreator;
				}
				else {
					var matches = andEtAlRegExp.exec(firstCreator);
					var fieldA = matches ? matches[0] : '';
				}
				creatorSortCache[aItemID] = fieldA;
			}
			if (fieldB === undefined) {
				let firstCreator = Zotero.Items.getSortTitle(sortStringB);
				if (sortCreatorAsString) {
					var fieldB = firstCreator;
				}
				else {
					var matches = andEtAlRegExp.exec(firstCreator);
					var fieldB = matches ? matches[0] : '';
				}
				creatorSortCache[bItemID] = fieldB;
			}
			
			if (fieldA === "" && fieldB === "") {
				return 0;
			}
			
			// Display rows with empty values last
			if (fieldA === '' && fieldB !== '') return 1;
			if (fieldA !== '' && fieldB === '') return -1;
			
			return collation.compareString(1, fieldA, fieldB);
		}
		
		// Need to close all containers before sorting
		if (!this.selection.selectEventsSuppressed) {
			var unsuppress = this.selection.selectEventsSuppressed = true;
		}
		
		var savedSelection = this.getSelectedItems(true);
		// TODO:
		// var openItemIDs = this._saveOpenState(true);
		
		// Sort specific items
		if (itemIDs) {
			let idsToSort = new Set(itemIDs);
			this._rows.sort((a, b) => {
				// Don't re-sort existing items. This assumes a stable sort(), which is the case in Firefox
				// but not Chrome/v8.
				if (!idsToSort.has(a.ref.id) && !idsToSort.has(b.ref.id)) return 0;
				return rowSort(a, b) * order;
			});
		}
		// Full sort
		else {
			this._rows.sort((a, b) => rowSort(a, b) * order);
		}
		
		this._refreshItemRowMap();
		
		// this.rememberOpenState(openItemIDs);
		this._rememberSelection(savedSelection);
		
		if (unsuppress) {
			this.selection.selectEventsSuppressed = false;
		}
		
		this.forceUpdate();
		
		var numSorted = itemIDs ? itemIDs.length : this._rows.length;
		Zotero.debug(`Sorted ${numSorted} ${Zotero.Utilities.pluralize(numSorted, ['item', 'items'])} `
			+ `in ${new Date - t} ms`);
	}

	// TODO: consolidate
	// The caller has to ensure the tree is redrawn
	ensureRowIsVisible(index) {
		this._treebox && this._treebox.scrollToRow(index);
	}

	ensureRowsAreVisible(indices) {
		let itemHeight = 20; // px
		if (Zotero.isLinux) {
			itemHeight = 22;
		}
		itemHeight *= Zotero.Prefs.get('fontSize');
		
		const pageLength = Math.floor(this.domEl.parentElement.clientHeight / itemHeight);
		const maxBuffer = 5;
		
		indices = indices.concat();
		indices.sort((a, b) => a - b);
		
		var indicesWithParents = [];
		for (let row of indices) {
			let parent = this.getParentIndex(row);
			indicesWithParents.push(parent != -1 ? parent : row);
		}
		
		// If we can fit all parent indices in view, do that
		for (let buffer = maxBuffer; buffer >= 0; buffer--) {
			if (indicesWithParents[indicesWithParents.length - 1] - indicesWithParents[0] - buffer < pageLength) {
				//Zotero.debug(`We can fit all parent indices with buffer ${buffer}`);
				this.ensureRowIsVisible(indicesWithParents[0] - buffer);
				return;
			}
		}
		
		// If we can fit all indices in view, do that
		for (let buffer = maxBuffer; buffer >= 0; buffer--) {
			if (indices[indices.length - 1] - indices[0] - buffer < pageLength) {
				//Zotero.debug(`We can fit all indices with buffer ${buffer}`);
				this.ensureRowIsVisible(indices[0] - buffer);
				return;
			}
		}
	
		// If the first parent row isn't in view and we have enough room, make it visible, trying to
		// put it five indices from the top
		if (indices[0] != indicesWithParents[0]) {
			for (let buffer = maxBuffer; buffer >= 0; buffer--) {
				 if (indices[0] - indicesWithParents[0] - buffer <= pageLength) {
					//Zotero.debug(`Scrolling to first parent minus ${buffer}`);
					this.ensureRowIsVisible(indicesWithParents[0] - buffer);
					return;
				}
			}
		}
		
		// Otherwise just put the first row at the top
		//Zotero.debug("Scrolling to first row " + Math.max(indices[0] - maxBuffer, 0));
		this.ensureRowIsVisible(Math.max(indices[0] - maxBuffer, 0));
	}
	
	// //////////////////////////////////////////////////////////////////////////////
	//
	//  Data access methods
	//
	// //////////////////////////////////////////////////////////////////////////////

	// TODO: consolidate
	get selection() {
		return this.tree ? this.tree.selection : null;
	}
	
	get rowCount() {
		return this._rows.length;
	}
	
	// TODO: consolidate
	getParentIndex = (index) => {
		var thisLevel = this.getLevel(index);
		if (thisLevel == 0) return -1;
		for (var i = index - 1; i >= 0; i--) {
			if (this.getLevel(i) < thisLevel) {
				return i;
			}
		}
		return -1;
	}

	// TODO: consolidate
	/**
	 * Return a reference to the tree row at a given row
	 *
	 * @return {Zotero.CollectionTreeRow}
	 */
	getRow(index) {
		return this._rows[index];
	}
	
	getSelectedItems(asIDs) {
		var items = this.selection ? Array.from(this.selection.selected) : [];
		if (asIDs) return items;
		return items.map(id => this.getRow(id).ref);
	}

	// //////////////////////////////////////////////////////////////////////////////
	//
	//  Private methods
	//
	// //////////////////////////////////////////////////////////////////////////////

	// TODO: consolidate
	_refreshItemRowMap() {
		var rowMap = {};
		for (var i=0, len=this.rowCount; i<len; i++) {
			let row = this.getRow(i);
			let id = row.ref.id;
			if (rowMap[id] !== undefined) {
				Zotero.debug(`WARNING: Item row ${rowMap[id]} already found for item ${id} at ${i}`, 2);
				Zotero.debug(new Error().stack, 2);
			}
			rowMap[id] = i;
		}
		this._rowMap = rowMap;
	}
	
	_getRowData = ({ index }) => {
		var treeRow = this.getRow(index);
		var itemID = treeRow.id;
		
		// If value is available, retrieve synchronously
		if (this._rowCache[itemID]) {
			return this._rowCache[itemID];
		}
		
		let row = {};
		
		// Mark items not matching search as context rows, displayed in gray
		if (this._searchMode && !this._searchItemIDs.has(itemID)) {
			row.contextRow = true;
		}
		
		row.hasAttachment = "";
		// TODO:
		// Don't show pie for open parent items, since we show it for the
		// child item
		// if (!this.isContainer(row) || !this.isContainerOpen(row)) {
		// 	var num = Zotero.Sync.Storage.getItemDownloadImageNumber(treeRow.ref);
		// 	//var num = Math.round(new Date().getTime() % 10000 / 10000 * 64);
		// 	if (num !== false) props.push("pie", "pie" + num);
		// }
		
		// Style unread items in feeds
		if (treeRow.ref.isFeedItem && !treeRow.ref.isRead) {
			row.unread = true;
		}
		
		
		row.itemType = Zotero.ItemTypes.getLocalizedString(treeRow.ref.itemTypeID);
		// Year column is just date field truncated
		row.year = treeRow.getField('date', true).substr(0, 4);
		row.numNotes = treeRow.numNotes() || "";
		row.title = treeRow.ref.getDisplayTitle();
		
		for (let col of COLUMNS) {
			let key = col.dataKey;
			let val = row[key];
			if (val === undefined) {
				val = treeRow.getField(key);
			}
			
			switch (key) {
			// Format dates as short dates in proper locale order and locale time
			// (e.g. "4/4/07 14:27:23")
			case 'dateAdded':
			case 'dateModified':
			case 'accessDate':
			case 'date':
				if (key == 'date' && !this.collectionTreeRow.isFeed()) {
					break;
				}
				if (val) {
					let date = Zotero.Date.sqlToDate(val, true);
					if (date) {
						// If no time, interpret as local, not UTC
						if (Zotero.Date.isSQLDate(val)) {
							date = Zotero.Date.sqlToDate(val);
							val = date.toLocaleDateString();
						}
						else {
							val = date.toLocaleString();
						}
					}
					else {
						val = '';
					}
				}
			}
			row[key] = val;
		}
		
		return this._rowCache[itemID] = row;
	}
	
	_storeColumnVisibility(visibilityGroup) {
		let settings = JSON.parse(Zotero.Prefs.get('itemsView.columnVisibility') || '{}');
		// Store previous view settings
		let setting = {};
		for (let col of this.columns) {
			let colType = col.id.substring('zotero-items-column-'.length);
			setting[colType] = !!col.hidden;
		}
		settings[visibilityGroup] = setting;
		Zotero.Prefs.set('itemsView.columnVisibility', JSON.stringify(settings));
	}
	
	_getColumns() {
		if (!this.collectionTreeRow) {
			return [];
		}
		let visibilityGroup = this.collectionTreeRow.visibilityGroup;
		let settings = JSON.parse(Zotero.Prefs.get('itemsView.columnVisibility') || '{}');
		let setting = settings[visibilityGroup] = {};
		let persistSettings = JSON.parse(Zotero.Prefs.get('pane.persist') || {});
		let columns = [];
		let columnWidths = {};
		let visibleColumns = 0;
		for (let column of COLUMNS) {
			let legacyDataKey = "zotero-items-column-" + column.dataKey;
			let persistSetting = persistSettings[legacyDataKey];
			for (let key in persistSetting) {
				if (typeof persistSetting[key] == "string") {
					try {
						persistSetting[key] = JSON.parse(persistSetting[key]);
					} catch (e) {}
				}
			}
			column = Object.assign({}, column, persistSetting);
			// IF no setting OR the column isn't in the setting
			// AND not in the default group
			// THEN the column is hidden
			if (!(setting[column.dataKey] || setting[legacyDataKey])
					&& (!column.defaultIn || !column.defaultIn.has(visibilityGroup))) {
				column.hidden = true;
			}
			if (!column.hidden) {
				visibleColumns++;
			}
			column.className = column.dataKey + this._cssSuffix;
			columns.push(column);
		}
		for (let column of COLUMNS) {
			if (!column.hidden) {
				if (column.width) {
					columnWidths[column.dataKey] = column.width;
				}
				else {
					columnWidths[column.dataKey] = this.domEl.clientWidth / visibleColumns;
				}
			}
		}
		this._resizeColumns(columnWidths);
		return columns;
	}

	_resizeColumns = (columns) => {
		for (let dataKey in columns) {
			let [styleIndex, _] = this._columnStyleMap[dataKey];
			this._stylesheet.sheet.cssRules[styleIndex].style.cssText = `flex-basis: ${columns[dataKey]}px`;
		}
	}
	
	_handleHeaderClick = async (index) => {
		let column = this._columns[index];
		if (this.collectionTreeRow.isFeed()) {
			return;
		}
		if (column.dataKey == 'hasAttachment') {
			Zotero.debug("Caching best attachment states");
			if (!this._cachedBestAttachmentStates) {
				let t = new Date();
				for (let i = 0; i < this._rows.length; i++) {
					let item = this.getRow(i).ref;
					if (item.isRegularItem()) {
						await item.getBestAttachmentState();
					}
				}
				Zotero.debug("Cached best attachment states in " + (new Date - t) + " ms");
				this._cachedBestAttachmentStates = true;
			}
		}
		if (this._sortedColumn && this._sortedColumn.dataKey == column.dataKey) {
			this._sortedColumn.sortDirection *= -1;
		}
		else {
			if (this._sortedColumn) {
				delete this._sortedColumn.sortDirection;
			}
			this._sortedColumn = column;
			this._sortedColumn.sortDirection = 1;
		}
		
		this.selection.selectEventsSuppressed = true;
		var savedSelection = this.getSelectedItems(true);
		if (savedSelection.length == 1) {
			var pos = this._rowMap[savedSelection[0]] - this._treebox.getFirstVisibleRow();
		}
		this.sort();
		this._rememberSelection(savedSelection);
		// If single row was selected, try to keep it in the same place
		if (savedSelection.length == 1) {
			var newRow = this._rowMap[savedSelection[0]];
			// Calculate the last row that would give us a full view
			var fullTop = Math.max(0, this._rows.length - this._treebox.getPageLength());
			// Calculate the row that would give us the same position
			var consistentTop = Math.max(0, newRow - pos);
			this._treebox.scrollToRow(Math.min(fullTop, consistentTop));
		}
		this._treebox.invalidate();
		this.selection.selectEventsSuppressed = false;
	}


	/*
	 *  Sets the selection based on saved selection ids
	 */
	_rememberSelection(selection) {
		if (!selection.length) {
			return;
		}
		
		this.selection.clearSelection();
		
		if (!this.selection.selectEventsSuppressed) {
			var unsuppress = this.selection.selectEventsSuppressed = true;
			this._treebox.beginUpdateBatch();
		}
		
		try {
			for (let i = 0; i < selection.length; i++) {
				if (this._rowMap[selection[i]] != null) {
					this.selection.toggleSelect(this._rowMap[selection[i]]);
				}
				// Try the parent
				else {
					var item = Zotero.Items.get(selection[i]);
					if (!item) {
						continue;
					}
					
					var parent = item.parentItemID;
					if (!parent) {
						continue;
					}
					
					if (this._rowMap[parent] != null) {
						this._closeContainer(this._rowMap[parent]);
						this.toggleOpenState(this._rowMap[parent]);
						this.selection.toggleSelect(this._rowMap[selection[i]]);
					}
				}
			}
		}
		// Ignore NS_ERROR_UNEXPECTED from nsITreeSelection::toggleSelect(), apparently when the tree
		// disappears before it's called (though I can't reproduce it):
		//
		// https://forums.zotero.org/discussion/69226/papers-become-invisible-in-the-middle-pane
		catch (e) {
			Zotero.logError(e);
		}
		
		if (unsuppress) {
			this._treebox.endUpdateBatch();
			this.selection.selectEventsSuppressed = false;
		}
	}
	
	
	_getSortField() {
		if (this.collectionTreeRow.isFeed()) {
			return 'id';
		}
		var column = this._sortedColumn;
		if (!column) {
			column = this._columns.find(col => !col.hidden);
		}
		// zotero-items-column-_________
		return column.dataKey;
	}


	_getSortFields() {
		var fields = [this._getSortField()];
		var secondaryField = this._getSecondarySortField();
		if (secondaryField) {
			fields.push(secondaryField);
		}
		try {
			var fallbackFields = Zotero.Prefs.get('fallbackSort')
				.split(',')
				.map((x) => x.trim())
				.filter((x) => x !== '');
		}
		catch (e) {
			Zotero.debug(e, 1);
			Components.utils.reportError(e);
			// This should match the default value for the fallbackSort pref
			var fallbackFields = ['firstCreator', 'date', 'title', 'dateAdded'];
		}
		fields = Zotero.Utilities.arrayUnique(fields.concat(fallbackFields));
		
		// If date appears after year, remove it, unless it's the explicit secondary sort
		var yearPos = fields.indexOf('year');
		if (yearPos != -1) {
			let datePos = fields.indexOf('date');
			if (datePos > yearPos && secondaryField != 'date') {
				fields.splice(datePos, 1);
			}
		}
		
		return fields;
	}
	
	_getSecondarySortField() {
		var primaryField = this._getSortField();
		var secondaryField = Zotero.Prefs.get('secondarySort.' + primaryField);
		if (!secondaryField || secondaryField == primaryField) {
			return false;
		}
		return secondaryField;
	}
	
	_getIcon(index) {
		// Get item type icon and tag swatches
		var item = this.getRow(index).ref;
		var itemType = Zotero.ItemTypes.getName(item.itemTypeID);
		if (itemType == 'attachment') {
			var linkMode = this.attachmentLinkMode;
			
			if (this.attachmentContentType == 'application/pdf' && this.isFileAttachment()) {
				if (linkMode == Zotero.Attachments.LINK_MODE_LINKED_FILE) {
					itemType += 'PdfLink';
				}
				else {
					itemType += 'Pdf';
				}
			}
			else if (linkMode == Zotero.Attachments.LINK_MODE_IMPORTED_FILE) {
				itemType += "File";
			}
			else if (linkMode == Zotero.Attachments.LINK_MODE_LINKED_FILE) {
				itemType += "Link";
			}
			else if (linkMode == Zotero.Attachments.LINK_MODE_IMPORTED_URL) {
				itemType += "Snapshot";
			}
			else if (linkMode == Zotero.Attachments.LINK_MODE_LINKED_URL) {
				itemType += "WebLink";
			}
		}
		let iconClsName = "IconTreeitem" + Zotero.Utilities.capitalize(itemType);
		if (!Icons[iconClsName]) {
			iconClsName = "IconTreeitem";
		}
		// N.B. Should use css-image-set in Electron
		if (window.devicePixelRatio >= 1.25 && ((iconClsName + "2x") in Icons)) {
			iconClsName += "2x";
		}
		return getDomIcon(iconClsName);
	}
};

Zotero.Utilities.Internal.makeClassEventDispatcher(Zotero.ItemTree);

})();
