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
const JSWindow = require('./js-window');
const { injectIntl } = require('react-intl');
const { TreeSelection } = require('./virtualized-tree');
const cx = require('classnames');
const Draggable = require('react-draggable').DraggableCore;

const CELL_PADDING = 10; // px
const RESIZER_WIDTH = 5; // px

class VirtualizedTable extends React.Component {
	constructor(props) {
		super(props);
		this.state = {
			resizing: null
		};
		this._resizingColumn = null;
		this._jsWindowID = `virtualized-table-list-${Zotero.Utilities.randomString(5)}`;
			
		this.selection = new TreeSelection(this);
		
		this.onSelection = Zotero.Utilities.debounce(this._onSelection, 20);
	}
	
	// ------------------------ Selection Methods ------------------------- //
		
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
			case " ":
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
		
		let shiftSelect = e.shiftKey;
		let movePivot = e.ctrlKey || e.metaKey;

		switch (e.key) {
		case "ArrowUp":
			let prevSelect = this.selection.focused - 1;
			while (prevSelect > 0 && !this.props.isSelectable(prevSelect)) {
				prevSelect--;
			}
			prevSelect = Math.max(0, prevSelect);
			this.onSelection(prevSelect, shiftSelect, false, movePivot);
			break;

		case "ArrowDown":
			let nextSelect = this.selection.focused + 1;
			while (nextSelect < this.props.rowCount && !this.props.isSelectable(nextSelect)) {
				nextSelect++;
			}
			nextSelect = Math.min(nextSelect, this.props.rowCount - 1);
			this.onSelection(nextSelect, shiftSelect, false, movePivot);
			break;

		case "Home":
			this.onSelection(0, shiftSelect, false, movePivot);
			break;

		case "End":
			this.onSelection(this.props.rowCount - 1, shiftSelect, false, movePivot);
			break;
			
		case "PageUp":
			this._onJumpSelect(-1, shiftSelect);
			break;
			
		case "PageDown":
			this._onJumpSelect(1, shiftSelect);
			break;
			
		case " ": 
			this.onSelection(this.selection.focused, false, true);
			break;
		}
		
		
		if (shiftSelect || movePivot) return;
		
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
				}
				else {
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
		let shiftSelect = e.shiftKey;
		let toggleSelection = e.ctrlKey || e.metaKey;
		this.onSelection(index, shiftSelect, toggleSelection);
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
		this._jsWindow.scrollToRow(index);
	}

	/**
	 * Updates the selection object
	 *
	 * @param {Number} index
	 *        The index of the item in a full DFS traversal (ignoring collapsed
	 *        nodes). Ignored if `item` is undefined.
	 *
	 * @param {Boolean} shiftSelect
	 * 		  If true will select from focused up to index (does not update pivot)
	 *
	 * @param {Boolean} toggleSelection
	 * 		  If true will add to selection
	 *
	 * @param {Boolean} movePivot
	 * 		  Will move focused without adding anything to the selection
	 */
	_onSelection = (index, shiftSelect, toggleSelection, movePivot) => {
		if (this.selection.selectEventsSuppressed) return;
		
		if (movePivot) {
			this.selection.focused = index;
			this.selection.pivot = index;
		}
		// Normal selection
		else if (!shiftSelect && !toggleSelection) {
			while (index > 0 && !this.props.isSelectable(index)) {
				index--;
			}
			this.selection.select(index);
		}
		// Range selection
		else if (shiftSelect && this.props.multiSelect) {
			this.selection.shiftSelect(index);
		}
		// If index is not selectable and this is not normal selection we return
		else if (!this.props.isSelectable(index)) {
			return;
		}
		// Additive selection
		else if (this.props.multiSelect) {
			this.selection.toggleSelect(index);
		}
		// None of the previous conditions were satisfied, so nothing changes
		else {
			return;
		}

		this.scrollToRow(index);
	}
	
	// ------------------------ Column Methods ------------------------- //
	
	_handleResizerDragStart(index, event) {
		if (event.button !== 0) return;

		this._resizingColumn = event.target.nextSibling;
		this.setState({ resizing: index });
		
		let onResizeData = {};
		const columns = this.props.columns.filter(col => !col.hidden);
		for (let i = 0; i < columns.length; i++) {
			let elem = this._resizingColumn.parentNode.children[i * 2];
			onResizeData[columns[i].dataKey] = elem.getBoundingClientRect().width - CELL_PADDING;
		}
		this.props.onColumnResize(onResizeData);
	}

	_handleResizerDrag = (event) => {
		event.stopImmediatePropagation();
		const columns = this.props.columns;
		const index = this.state.resizing;
		const b = this._resizingColumn;
		const a = b.previousSibling.previousSibling;
		const aRect = a.getBoundingClientRect();
		const bRect = b.getBoundingClientRect();
		const offset = aRect.x;
		const widthSum = aRect.width + bRect.width;
		// Column min-width: 20px;
		columns[index - 1].width = Math.min(widthSum - 20, Math.max(20, event.clientX - (RESIZER_WIDTH / 2) - offset));
		columns[index].width = widthSum - columns[index - 1].width;
		let onResizeData = {};
		onResizeData[columns[index - 1].dataKey] = columns[index - 1].width - CELL_PADDING;
		onResizeData[columns[index].dataKey] = columns[index].width - CELL_PADDING;
		this.props.onColumnResize(onResizeData);
	}

	_handleResizerDragStop = () => {
		this._resizingColumn = null;
		this.setState({ resizing: null });
	}

	componentDidMount() {
		this._jsWindow = new JSWindow(this._getJSWindowOptions());
		this.props.treeboxRef(this._jsWindow);
		this._jsWindow.initialize();
		this._jsWindow.render();
	}
	
	_getJSWindowOptions() {
		return {
			itemCount: this.props.rowCount,
			itemHeight: this.props.rowHeight,
			height: this.props.height - this._topDiv.firstChild.clientHeight,
			renderItem: this._renderItem,
			targetElement: document.getElementById(this._jsWindowID),
		};
	}

	_renderItem = (index) => {
		let node = this.props.renderItem(index, this.selection);
		node.addEventListener('mousedown', e => this._onMouseDown(e, index), { passive: true });
		return node;
	}

	_renderHeaderCells = () => {
		return this.props.columns.map((column, index) => {
			if (column.hidden) return;
			let label = this.props.intl.formatMessage({ id: column.label });
			let draggable = "";
			if (index != 0) {
				draggable = (<Draggable
					onStart={this._handleResizerDragStart.bind(this, index)}
					onDrag={this._handleResizerDrag}
					onStop={this._handleResizerDragStop}
					enableUserSelectHack={false}
					key={label + '-resizer'}>
					<div className="resizer"/>
				</Draggable>);
			}
			let sortIndicator = "";
			if (column.sortDirection) {
				sortIndicator = <span className={"sort-indicator " + (column.sortDirection == 1 ? "ascending" : "descending")}/>;
			}
			return (<React.Fragment key={label + 'column'}>
				{draggable}
				<span
					onClick={() => this.props.onHeaderClick(index)}
					className={"cell " + column.className}
					key={label}>
					{label}
					{sortIndicator}
				</span>
			</React.Fragment>);
		});
	}
		
	render() {
		let headerCells = this._renderHeaderCells();
		if (this._jsWindow) {
			(async () => this._jsWindow.update(this._getJSWindowOptions()))();
		}
		let props = {
			onKeyDown: this._onKeyDown,
			onDragOver: this._onDragOver,
			className: cx(["virtualized-table", { resizing: this.state.resizing }]),
			id: this.props.id,
			ref: ref => this._topDiv = ref,
			tabIndex: 0,
		};
		let jsWindowProps = {
			id: this._jsWindowID,
			className: "virtualized-table-body",
			onFocus: (e) => {
				if (e.target.id == this._jsWindowID) {
					// Focus should always remain on the list itself.
					this._topDiv.focus();
				}
			},
			tabIndex: -1
		};
		return (
			<div {...props}>
				<div className="virtualized-table-header">{headerCells}</div>
				<div {...jsWindowProps} />
			</div>
		);
	}
	
	invalidate() {
		return this._jsWindow.invalidate();
	}
	
	invalidateRow(index) {
		this._jsWindow.rerenderItem(index);
	}
	
	invalidateRange(startIndex, endIndex) {
		for (; startIndex <= endIndex; startIndex++) {
			this._jsWindow.rerenderItem(startIndex);
		}
	}
}

module.exports = injectIntl(VirtualizedTable, { forwardRef: true });
