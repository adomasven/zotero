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
const { renderToStaticMarkup } = require('react-dom-server');
const { div } = require('react-dom-factories');
const PropTypes = require('prop-types');
const { IntlProvider } = require('react-intl');
const VirtualizedTable = require('components/virtualized-table');
const { IconTwisty } = require('components/icons');
const Icons = require('components/icons');
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
	let rowCache = {};
	
	function renderPrimaryCell(index, label, column) {
		let span = renderCell(index, label, column);
		// let icon = renderToStaticMarkup(itemTree._getIcon(index));
		let icon = `<span class="icon" style="background-image: url(${itemTree._rows[index].ref.getImageSrc()})"></span>`;
		// let arrow = renderToStaticMarkup(<IconTwisty className="arrow"/>);
		let arrow = `<span class="icon icon-twisty arrow"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
		<path d="M8 13.4c-.5 0-.9-.2-1.2-.6L.4 5.2C0 4.7-.1 4.3.2 3.7S1 3 1.6 3h12.8c.6 0 1.2.1 1.4.7.3.6.2 1.1-.2 1.6l-6.4 7.6c-.3.4-.7.5-1.2.5z"/>
	</svg></span>`;
		span.classList.add('primary');
		span.innerHTML = `${arrow}${icon}${span.innerHTML}`;
		return span;
	}
	
	function renderCell(index, label, column) {
		let span = document.createElementNS("http://www.w3.org/1999/xhtml", 'span');
		span.className = `cell ${column.className}`;
		span.innerText = label;
		return span;
	}
	
	function recycleRow(index, div) {
		let rowData = itemTree._rowGetter({ index });
		
		for (let i = 0; i < div.children.length; i++) {
			let column = itemTree._columns[i];
			let child = div.children[i];
			if (child.classList.contains('primary')) {
				div.replaceChild(renderPrimaryCell(index, rowData[column.dataKey], column), child);
			}
			else {
				child.innerText = rowData[column.dataKey];
			}
		}
		
		return div;
	}
	
	return function (index, startIndex, endIndex, appendElem) {
		// let renderedIndices = Object.keys(rowCache);
		// let smallestRendered = Math.min(...renderedIndices);
		// let recycleIndex = null;
		// if (smallestRendered < startIndex) {
		// 	recycleIndex = smallestRendered;
		// }
		// if (recycleIndex === null) {
		// 	let largestRendered = Math.max(...renderedIndices);
		// 	if (largestRendered > endIndex) {
		// 		recycleIndex = largestRendered;
		// 	}
		// }
		// if (recycleIndex !== null) {
		// 	// Zotero.debug('Recycling row ' + recycleIndex);
		// 	let recycledRow = recycleRow(index, rowCache[recycleIndex]);
		// 	delete rowCache[recycleIndex];
		// 	rowCache[index] = recycledRow;
		// 	return recycledRow;
		// }
		
		let rowData = itemTree._rowGetter({ index });
		let div = document.createElementNS("http://www.w3.org/1999/xhtml", 'div');
		div.className = "row";
		
		for (let column of itemTree._columns) {
			if (column.hidden) continue;
			
			if (column.primary) {
				div.appendChild(renderPrimaryCell(index, rowData[column.dataKey], column));
			}
			else {
				div.appendChild(renderCell(index, rowData[column.dataKey], column));
			}
		}
		
		rowCache[index] = div;
		
		appendElem.appendChild(div);
		
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
		// (async function () {
		// 	ref.makeVisible();
		// })();
		
		return ref;
	}
	
	constructor(props) {
		super(props);
		
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
		
		this.ItemRenderer = makeItemRenderer(this);

		this.onLoad = this._createEventBinding('load', true, true);
		this.onSelect = this._createEventBinding('select');
		this.onRefresh = this._createEventBinding('refresh');

		this._cssSuffix = '-' + Zotero.Utilities.randomString(5);
		this._columns = this._getColumns(this._cssSuffix);

		this._stylesheet = document.createElementNS("http://www.w3.org/1999/xhtml", 'style');
		this._columnStyleMap = {};
		document.children[0].appendChild(this._stylesheet);
		for (let i = 0; i < this._columns.length; i++) {
			let column = this._columns[i];
			this._stylesheet.sheet.insertRule(`.${column.className} {flex-basis: 100px}`, i);
			this._columnStyleMap[column.dataKey] = [i, column.className];
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
			
			if (!this.selection.selectEventsSuppressed) {
				var unsuppress = this.selection.selectEventsSuppressed = true;
				// this._treebox.beginUpdateBatch();
			}
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
			if (unsuppress) {
				// this._treebox.endUpdateBatch();
				this.selection.selectEventsSuppressed = false;
			}
			
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

		let headerHeight = 28 * Zotero.Prefs.get('fontSize');
		
		if (!this.collectionTreeRow) {
			return div("LOADING");
		}

		ZoteroPane.clearItemsPaneMessage();
		return React.createElement(VirtualizedTable,
			{
				height: this.domEl.parentElement.clientHeight,
				width: this.props.width || window.innerWidth,
				container: this.domEl.parentElement,
				rowCount: this._rows.length,
				rowHeight: itemHeight,
				headerHeight: headerHeight,
				id: "item-tree",
				rowGetter: this._rowGetter,
				rowRenderer: this._rowRenderer,
				primaryCellRenderer: this._primaryCellRenderer,
				ref: tree => this.ref = tree,
				columns: this._columns,
				children: this.ItemRenderer,
				itemKey: index => this.getRow(index).id,
				
				multiSelect: true,
				currentViewGroup: this.collectionTreeRow.visibilityGroup,
				
				getParentIndex: this.getParentIndex,
				// getAriaLabel: index => this.getRow(index).getName(),
				// isSelectable: this.isSelectable,
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
				onColumnResize: this.handleColumnResize,

				label: Zotero.getString('pane.collections.title'),
			}
		);
	}
	
	handleColumnResize = (columns) => {
		for (let dataKey in columns) {
			let [styleIndex, _] = this._columnStyleMap[dataKey];
			this._stylesheet.sheet.cssRules[styleIndex].style.cssText = `flex-basis: ${columns[dataKey]}px`;
		}
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
		this._columns = this._getColumns(this._cssSuffix);
		await this.refresh();
		this.forceUpdate();
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

	// TODO: consolidate
	// The caller has to ensure the tree is redrawn
	ensureRowIsVisible(index) {
		this.ref && this.ref.scrollToRow(index);
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
		return this.ref ? this.ref.selection : { select: () => 0, selected: [] };
	}

	set selection(val) {
		return this.ref.selection = val;
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
		var items = Array.from(this.selection.selected);
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
	
	_rowGetter = ({ index }) => {
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

	_rowRenderer = ({ index, key, style, className, rowData, columns }, { selection }) => {
		let treeRow = this.getRow(index);
		let depth = treeRow.level;
		let icon = this._getIcon(index);
		let classes = cx(['tree-node',
			{
				focused: selection.isSelected(index),
				drop: this._dropRow == treeRow.id,
				unread: rowData.unread
			},
			className
		]);

		// The arrow on macOS is a full icon's width.
		// For non-userLibrary items that are drawn under headers
		// we do not draw the arrow and need to move all items 1 level up
		if (Zotero.isMac && !treeRow.isHeader() && treeRow.ref
				&& treeRow.ref.libraryID != Zotero.Libraries.userLibraryID) {
			depth--;
		}


		let props = {
			style,
			key,
			className: classes,
			// onContextMenu: async (e) => {
			// 	e.persist();
			// 	this.selection.select(index);
			// 	this.props.onContext && this.props.onContext(e);
			// },
			draggable: treeRow != this._editing,
			children: COLUMNS
		};
		
		if (this.props.dragAndDrop) {
			// props.onDoubleClick = () => this.handleActivate(treeRow);
			// props.onDragStart = e => this.onDragStart(treeRow, e);
			// props.onDragOver = e => this.onDragOver(treeRow, e);
			// props.onDragEnd = e => this.onDragEnd(treeRow, e);
			// props.onDrop = e => this.onDrop(treeRow, e);
		}

		let arrowProps = {
			// onMouseDown: async (e) => {
			// 	e.stopPropagation();
			// 	e.preventDefault();
			// 	await this.toggleOpenState(index);
			// 	this.forceUpdate();
			// },
			className: 'arrow',
		};
		// arrowProps.className += this.isContainerOpen(index) ? ' open' : '';
		// let arrow = <IconTwisty {...arrowProps}/>;
		// if (!this.isContainer(index) || this.isContainerEmpty(index)) {
		// 	arrow = <span className='spacer-arrow'></span>;
		// }

		return (
			<div {...props}>
				{columns}
			</div>
		);
	}
	
	_primaryCellRenderer = ({ cellData, rowIndex: index }) => {
		let treeRow = this.getRow(index);
		let depth = 0;
		let icon = this._getIcon(index);

		// The arrow on macOS is a full icon's width.
		// For non-userLibrary items that are drawn under headers
		// we do not draw the arrow and need to move all items 1 level up
		// if (Zotero.isMac && !treeRow.isHeader() && treeRow.ref
		// 		&& treeRow.ref.libraryID != Zotero.Libraries.userLibraryID) {
		// 	depth--;
		// }


		let props = {
			style: {
				paddingLeft: (CHILD_INDENT * depth) + 'px'
			},
			className: "cell primary"
		};

		let arrowProps = {
			// onMouseDown: async (e) => {
			// 	e.stopPropagation();
			// 	e.preventDefault();
			// 	await this.toggleOpenState(index);
			// 	this.forceUpdate();
			// },
			className: 'arrow',
		};
		// arrowProps.className += this.isContainerOpen(index) ? ' open' : '';
		let arrow = <IconTwisty {...arrowProps}/>;
		// if (!this.isContainer(index) || this.isContainerEmpty(index)) {
		// 	arrow = <span className='spacer-arrow'></span>;
		// }

		return (
			<span {...props}>
				{/*{arrow}*/}
				{/*{icon}*/}
				{cellData}
			</span>
		);
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
	
	_getColumns(cssSuffix) {
		// if (!this.collectionTreeRow) {
		// 	return [];
		// }
		// let visibilityGroup = this.collectionTreeRow.visibilityGroup;
		// let settings = JSON.parse(Zotero.Prefs.get('itemsView.columnVisibility') || '{}');
		// let setting = settings[visibilityGroup] = {};
		let persistSettings = JSON.parse(Zotero.Prefs.get('pane.persist') || {});
		let columns = [];
		let defaultColumnWidth = this.domEl.parentElement.clientWidth / COLUMNS.length;
		for (let column of COLUMNS) {
			let legacyDataKey = "zotero-items-column-" + column.dataKey;
			let persistSetting = persistSettings[column.legacyDataKey];
			column = Object.assign({}, column, persistSetting);
			// IF no setting OR the column isn't in the setting
			// AND not in the default group
			// THEN the column is hidden
			// if (!(setting[column.dataKey] || setting[legacyDataKey])
			// 		&& (!column.defaultIn || !column.defaultIn.has(visibilityGroup))) {
			if (!column.defaultIn) {
				column.hidden = true;
			}
			column.width = column.width || defaultColumnWidth;
			column.className = column.dataKey + cssSuffix;
			columns.push(column);
		}
		return columns;
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
		// N.B. Should use css-image-set in Electron
		if (window.devicePixelRatio >= 1.25 && ((iconClsName + "2x") in Icons)) {
			iconClsName += "2x";
		}
		let iconCls = Icons[iconClsName];
		if (!iconCls) {
			return "";
		}
		return React.createElement(iconCls);
	}
};

Zotero.Utilities.Internal.makeClassEventDispatcher(Zotero.ItemTree);

})();
