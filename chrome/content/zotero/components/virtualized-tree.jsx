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
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.	See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.	If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

'use strict';

const React = require('react');
const ReactVirtualized = require('react-virtualized');

/**
 * Somewhat corresponds to nsITreeSelection
 */
class TreeSelection {
	constructor(tree) {
		this._tree = tree;
		Object.assign(this, {
			pivot: 0,
			_focused: 0,
			selected: new Set([]),
			_selectEventsSuppressed: false
		});
	}
	
	isSelected(index) {
		index = Math.max(0, index);
		return this.selected.has(index);
	}
	
	toggleSelect(index) {
		index = Math.max(0, index);
		if (this.selected.has(index)) {
			this.selected.delete(index);
		}
		else {
			this.selected.add(index);
		}
		
		if (this.selectEventsSuppressed) return;
		
		if (this._tree.invalidate) {
			this._tree.invalidateRow(index);
		}
		this.pivot = index;
		this._focused = index;
		this._updateTree();
	}
	
	clearSelection() {
		this.selected = new Set();
		if (this._tree.invalidate) {
			this._tree.invalidate();
		}
	}

	select(index) {
		index = Math.max(0, index);
		if (this.selected.size == 1 && this._focused == index && this.pivot == index) {
			return;
		}

		let toInvalidate = Array.from(this.selected);
		toInvalidate.push(index);
		this.selected = new Set([index]);
		this._focused = index;
		this.pivot = index;
		
		if (this.selectEventsSuppressed) return;
		
		this._tree.scrollToRow(index);
		this._updateTree();
		if (this._tree.invalidate) {
			toInvalidate.forEach(this._tree.invalidateRow.bind(this._tree));
		}
	}
	
	_rangedSelect(from, to, augment) {
		from = Math.max(0, from);
		to = Math.max(0, to);
		if (!augment) {
			this.clearSelection();
		}
		for (let i = from; i <= to; i++) {
			this.selected.add(i);
		}
	}
	
	rangedSelect(from, to, augment) {
		this._rangedSelect(from, to, augment);
		
		if (this.selectEventsSuppressed) return;

		if (this._tree.invalidate) {
			if (augment) {
				this._tree.invalidateRange(from, to);
			}
			else {
				this._tree.invalidate();
			}
		}
		this._updateTree();
	}
	
	shiftSelect(index) {
		index = Math.max(0, index);
		let from = Math.min(index, this.pivot);
		let to = Math.max(index, this.pivot);
		this._focused = index;
		this._rangedSelect(from, to);
		
		if (this.selectEventsSuppressed) return;

		if (this._tree.invalidate) {
			this._tree.invalidateRange(from, to);
		}
		this._updateTree();
	}
	
	_updateTree() {
		if (!this.selectEventsSuppressed && this._tree.props.onSelectionChange) {
			this._tree.props.onSelectionChange(this);
		}
	}
	
	get count() {
		return this.selected.size;
	}
	
	get focused() {
		return this._focused;
	}
	
	set focused(index) {
		index = Math.max(0, index);
		let oldValue = this._focused;
		this._focused = index;
		
		if (this.selectEventsSuppressed) return;
		
		this._updateTree();
		if (this._tree.invalidate) {
			this._tree.invalidateRow(oldValue);
			this._tree.invalidateRow(index);
		}
	}
	
	get selectEventsSuppressed() {
		return this._selectEventsSuppressed;
	}
	
	set selectEventsSuppressed(val) {
		this._selectEventsSuppressed = val;
		if (!val) {
			this._updateTree();
			if (this._tree.invalidate) {
				this._tree.invalidate();
			}
		}
	}
}

class VirtualizedTree extends React.Component {
	constructor() {
		super(...arguments);
		
		this.selection = new TreeSelection(this);
		
		this._listRef = React.createRef();
		
		this.onSelection = oncePerAnimationFrame(this._onSelection).bind(this);
	}
	
	_preventArrowKeyScrolling = (e) => {
		switch (e.key) {
			case "ArrowUp":
			case "ArrowDown":
			case "ArrowLeft":
			case "ArrowRight":
			case "PageUp":
			case "PageDown":
			case "Home":
			case "End":
				e.preventDefault();
				e.stopPropagation();
				if (e.nativeEvent) {
					if (e.nativeEvent.preventDefault) {
						e.nativeEvent.preventDefault();
					}
					if (e.nativeEvent.stopPropagation) {
						e.nativeEvent.stopPropagation();
					}
				}
		}
	}
	
	/**
	 * Ensure the tree scrolls when dragging over top and bottom parts of it
	 *
	 * @param e
	 * @private
	 */
	_onDragOver = (e) => {
		let tree = e.currentTarget;
		if (tree.id != this.props.id) return;
		let { y, height } = tree.getBoundingClientRect();
		let yBott = y + height;
		let threshold = this.props.rowHeight / 3;
		let scrollHeight = this.props.rowHeight * 3;
		if (e.clientY - y <= threshold) {
			// Already at top
			if (tree.scrollTop === 0) return;
			let scrollTo = Math.max(tree.scrollTop - scrollHeight, 0);
			tree.scrollTop = scrollTo;
		}
		else if (yBott - e.clientY <= threshold) {
			// Already at bottom
			if (tree.scrollTop === tree.scrollHeight - tree.clientHeight) return;
			let scrollTo = Math.min(
				tree.scrollTop + scrollHeight,
				tree.scrollHeight - tree.clientHeight
			);
			tree.scrollTop = scrollTo;
		}
	}

	/**
	 * Handles page up/down jumps
	 *
	 * @param {Integer} direction - -1 for up, 1 for down
	 * @param {Boolean} selectTo
	 * @private
	 */
	_onJumpSelect(direction, selectTo) {
		let numRows = Math.floor(this.props.height / this.props.rowHeight);
		let destination = this.selection.focused + (direction * numRows);
		destination = Math.min(destination, this.props.rowCount - 1);
		destination = Math.max(0, destination);
		this.onSelection(destination, selectTo);
	}

	/**
	 * Handles key down events in the tree's container.
	 *
	 * @param {Event} e
	 */
	_onKeyDown = (e) => {
		if (this.props.onKeyDown && this.props.onKeyDown(e) === false) return;

		this._preventArrowKeyScrolling(e);

		if (e.altKey) return;
		
		let selectTo = e.shiftKey;
		let movePivot = e.ctrlKey || e.metaKey;

		switch (e.key) {
			case "ArrowUp":
				let prevSelect = this.selection.focused - 1;
				while (prevSelect > 0 && !this.props.isSelectable(prevSelect)) {
					prevSelect--;
				}
				prevSelect = Math.max(0, prevSelect);
				this.onSelection(prevSelect, selectTo, false, movePivot);
				break;

			case "ArrowDown":
				let nextSelect = this.selection.focused + 1;
				while (nextSelect < this.props.rowCount && !this.props.isSelectable(nextSelect)) {
					nextSelect++;
				}
				nextSelect = Math.min(nextSelect, this.props.rowCount - 1);
				this.onSelection(nextSelect, selectTo, false, movePivot);
				break;

			case "Home":
				this.onSelection(0, selectTo, movePivot);
				break;

			case "End":
				this.onSelection(this.props.rowCount - 1, selectTo, false, movePivot);
				break;
				
			case "PageUp":
				this._onJumpSelect(-1, selectTo);
				break;
				
			case "PageDown":
				this._onJumpSelect(1, selectTo);
		}
		
		if (selectTo || movePivot) return;
		
		switch (e.key) {
			case "ArrowLeft":
				let parentIndex = this.props.getParentIndex(this.selection.focused);
				if (this.props.isContainer(this.selection.focused)
						&& !this.props.isContainerEmpty(this.selection.focused)
						&& this.props.isContainerOpen(this.selection.focused)) {
					this.props.toggleOpenState(this.selection.focused);
				}
				else if (parentIndex != -1) {
					this.onSelection(parentIndex);
				}
				break;

			case "ArrowRight":
				if (this.props.isContainer(this.selection.focused)
						&& !this.props.isContainerEmpty(this.selection.focused)) {
					if (!this.props.isContainerOpen(this.selection.focused)) {
						this.props.toggleOpenState(this.selection.focused);
					} else {
						this.onSelection(this.selection.focused + 1);
					}
				}
				break;

			case "Enter":
				this._activateNode();
				break;
		}
	}
	
	_onMouseDown = (e, index) => {
		let selectTo = e.shiftKey;
		let addToSelection = e.ctrlKey || e.metaKey;
		this.onSelection(index, selectTo, addToSelection);
	}

	_activateNode = () => {
		if (this.props.onActivate) {
			this.props.onActivate(this.selection.focused);
		}
	}

	/**
	 * Scroll the row into view. Delegates to virtualized-list
	 *
	 * @param index
	 */
	scrollToRow(index) {
		this._listRef.current.scrollToRow(index);
	}
	
	/**
	 * Force upgrade virtualized-grid. Delegates to virtualized-grid via virtualized-list
	 *
	 * @param index
	 */
	forceUpdateGrid() {
		this._listRef.current.forceUpdateGrid();
	}

	/**
	 * Updates the selection object
	 *
	 * @param {Number} index
	 *        The index of the item in a full DFS traversal (ignoring collapsed
	 *        nodes). Ignored if `item` is undefined.
	 *
	 * @param {Boolean} selectTo
	 * 		  If true will select from focused up to index (does not update focused)
	 *
	 * @param {Boolean} addToSelection
	 * 		  If true will add to selection
	 *
	 * @param {Boolean} movePivot
	 * 		  Will move focused without adding anything to the selection
	 */
	_onSelection(index, selectTo, addToSelection, movePivot) {
		if (this.selection.selectEventsSuppressed) return;
		
		// Normal selection
		if (!selectTo && !addToSelection) {
			while (index > 0 && !this.props.isSelectable(index)) {
				index--;
			}
			this.selection.select(index);
		}
		// If index is not selectable and this is not normal selection we return
		else if (!this.props.isSelectable(index)) {
			return;
		}
		else if (movePivot) {
			this.selection.focused = index;
		}
		// Additive selection
		else if (addToSelection && this.props.multiSelect) {
			this.selection.toggleSelect(index);
		}
		// Range selection
		else if (this.props.multiSelect) {
			let startIndex = Math.min(index, this.selection.focused);
			let endIndex = Math.max(index, this.selection.focused);
			this.selection.rangedSelect(startIndex, endIndex);
		}
		// None of the previous conditions were satisfied, so nothing changes
		else {
			return;
		}

		this.scrollToRow(index);
	}
	
	render() {
		if (this.selection.focused >= this.props.rowCount) {
			this.selection.focused = this.props.rowCount - 1;
		}
		let rowRendererArgs = {
			selection: this.selection,
		};
		let props = {
			rowRenderer: (reactVirtualizedObj) => {
				return (<div onMouseDown={e => this._onMouseDown(e, reactVirtualizedObj.index)}>
					{this.props.rowRenderer(reactVirtualizedObj, rowRendererArgs)}
				</div>);
			},
			ref: this._listRef,
			containerProps: {
				onClick: e => {
					if (!this.props.editing && this.props.id && e.target.id == this.props.id) {
						// Focus should always remain on the tree container itself.
						e.target.focus();
					}
				},
				onKeyDown: this._onKeyDown,
				onDragOver: this._onDragOver,
				"aria-label": this.props.label,
				"aria-activedescendant": this.props.rowCount && this.props.getAriaLabel
					&& this.props.getAriaLabel(this.selection.focused),
			}
		};
		if (!Zotero.isElectron) {
			// N.B. Reduces the rendering performance while scrolling but removes the
			// delay between scrolling and clicking
			// See https://github.com/bvaughn/react-virtualized/issues/564#issuecomment-277789650
			// Related to requestAnimationFrame not being available in required modules within XUL
			// See https://github.com/bvaughn/react-virtualized/pull/742
			// Untested in React, but should not be required
			props.containerStyle = {
				pointerEvents: "auto"
			};
		}
		for (let key of ['width', 'height', 'autoWidth', 'autoHeight', 'id',
					'className', 'rowCount', 'rowHeight']) {
			if (key in this.props) {
				props[key] = this.props[key];
			}
		}
		props.className += ' tree';
		return <ReactVirtualized.List {...props} />;
	}
}

/**
 * Create a function that calls the given function `fn` only once per animation
 * frame.
 *
 * @param {Function} fn
 * @returns {Function}
 */
function oncePerAnimationFrame(fn) {
	let animationId = null;
	let argsToPass = null;
	return function(...args) {
		argsToPass = args;
		if (animationId !== null) {
			return;
		}
		
		let debouncedFn = () => {
			fn.call(this, ...argsToPass);
			animationId = null;
			argsToPass = null;
		};

		if (typeof requestAnimationFrame == 'undefined') {
			animationId = setTimeout(debouncedFn, 20);
		} else {
			animationId = requestAnimationFrame(debouncedFn);
		}
	};
}

module.exports = VirtualizedTree;
module.exports.TreeSelection = TreeSelection;
