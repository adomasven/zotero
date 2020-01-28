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
const Draggable = require('./draggable');

const RESIZER_WIDTH = 5; // px

class VirtualizedTable extends React.Component {
	constructor(props) {
		super(props);
		this.state = {
			resizing: null
		};
		this._jsWindowID = `virtualized-table-list-${Zotero.Utilities.randomString(5)}`;
			
		this.selection = new TreeSelection(this);

		// Due to complicated reasons dragging (for column dragging and for resizing)
		// is not handled via React events but via native ones attached on `document`
		// Since React attaches its event handlers on `document` as well
		// there is no way to prevent bubbling. Thus we have to do custom
		// handling to prevent header resorting when "mouseup" event is issued
		// after dragging actions
		this.isHeaderMouseUp = true;
		
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
		if (direction == 1) {
			const lastVisible = this._jsWindow.getLastVisibleRow();
			if (this.selection.focused != lastVisible) {
				return this.onSelection(lastVisible, selectTo);
			}
		}
		else {
			const firstVisible = this._jsWindow.getFirstVisibleRow();
			if (this.selection.focused != firstVisible) {
				return this.onSelection(firstVisible, selectTo);
			}
		}
		const height = document.getElementById(this._jsWindowID).clientHeight;
		const numRows = Math.floor(height / this.props.rowHeight);
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
			this._activateNode(e);
			break;
		}
	}
	
	_onMouseDown = (e, index) => {
		let shiftSelect = e.shiftKey;
		let toggleSelection = e.ctrlKey || e.metaKey;
		this.onSelection(index, shiftSelect, toggleSelection);
	}

	_activateNode = (event, indices) => {
		if (this.props.onActivate) {
			this.props.onActivate(event, indices || Array.from(this.selection.selected));
		}
	}

	/**
	 * Scroll the row into view. Delegates to virtualized-list
	 *
	 * @param index
	 */
	scrollToRow(index) {
		this._jsWindow && this._jsWindow.scrollToItem(index);
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
	
	_handleResizerDragStart = (index, event) => {
		if (event.button !== 0) return false;
		event.stopPropagation();
		this.isHeaderMouseUp = false;
		const result = this._getResizeColumns(index);
		// No resizable columns on the left/right
		if (!result) return false;
		
		this.setState({ resizing: index });
		
		let onResizeData = {};
		const columns = this.props.columns.filter(col => !col.hidden);
		for (let i = 0; i < columns.length; i++) {
			let elem = event.target.parentNode.parentNode.children[i];
			onResizeData[columns[i].dataKey] = elem.getBoundingClientRect().width;
		}
		this.props.onColumnResize(onResizeData);
	}

	_handleResizerDrag = (event) => {
		event.stopPropagation();
		const result = this._getResizeColumns();
		if (!result) return;
		const [aColumn, bColumn] = result;
		const a = document.querySelector(`#${this.props.id} .virtualized-table-header .cell.${aColumn.dataKey}`);
		const b = document.querySelector(`#${this.props.id} .virtualized-table-header .cell.${bColumn.dataKey}`);
		const aRect = a.getBoundingClientRect();
		const bRect = b.getBoundingClientRect();
		const offset = aRect.x;
		const widthSum = aRect.width + bRect.width;
		// Column min-width: 20px;
		const aColumnWidth = Math.min(widthSum - 20, Math.max(20, event.clientX - (RESIZER_WIDTH / 2) - offset));
		const bColumnWidth = widthSum - aColumnWidth;
		let onResizeData = {};
		onResizeData[aColumn.dataKey] = aColumnWidth;
		onResizeData[bColumn.dataKey] = bColumnWidth;
		this.props.onColumnResize(onResizeData);
	}
	
	_getResizeColumns(index) {
		index = typeof index != "undefined" ? index : this.state.resizing;
		const columns = this.props.columns.filter(col => !col.hidden).sort((a, b) => a.ordinal - b.ordinal);
		let aColumn = columns[index - 1];
		let bColumn = columns[index];
		if (aColumn.fixedWidth) {
			for (let i = index - 2; i >= 0; i--) {
				aColumn = columns[i];
				if (!aColumn.fixedWidth) break;
			}
			if (aColumn.fixedWidth) {
				// All previous columns are fixed width
				return;
			}
		}
		if (bColumn.fixedWidth) {
			for (let i = index + 1; i < columns.length; i++) {
				bColumn = columns[i];
				if (!bColumn.fixedWidth) break;
			}
			if (bColumn.fixedWidth) {
				// All following columns are fixed width
				return;
			}
		}
		return [aColumn, bColumn];
	}

	_handleResizerDragStop = (event) => {
		event.stopPropagation();
		const result = this._getResizeColumns();
		if (!result) return;
		let resizeData = {};
		for (const column of result) {
			const elem = document.querySelector(`#${this.props.id} .virtualized-table-header .cell.${column.dataKey}`)
			resizeData[column.dataKey] = elem.getBoundingClientRect().width;
		}
		this.props.onColumnResize(resizeData, true);
		this.setState({ resizing: null });
	}
		
	_handleColumnDragStart = (index, event) => {
		if (!this.props.onColumnReorder || event.button !== 0) return false;
		this.setState({ dragging: index });
	}

	_handleColumnDragStop = (event, cancelled) => {
		if (!cancelled && typeof this.state.dragging == "number") {
			const { index } = this._findColumnDragPosition(event.clientX);
			// If inserting before the column that was being dragged
			// there is nothing to do
			if (this.state.dragging != index) {
				const visibleColumns = this.props.columns.filter(col => !col.hidden);
				const dragColumn = this.props.columns.findIndex(
					col => col == visibleColumns[this.state.dragging]);
				// Insert as final column (before end of list)
				let insertBeforeColumn = this.props.columns.length;
				// index == visibleColumns.length if dragged to the end of the view to be ordered
				// as the final column
				if (index < visibleColumns.length) {
					insertBeforeColumn = this.props.columns.findIndex(col => col == visibleColumns[index]);
				}
				this.props.onColumnReorder(dragColumn, insertBeforeColumn);
			}
		}
		this.setState({ dragging: null, dragX: null });
	}

	_handleColumnDrag = (event) => {
		const { offsetX } = this._findColumnDragPosition(event.clientX);
		this.isHeaderMouseUp = false;
		this.setState({ dragX: offsetX });
	}
	
	_handleHeaderMouseUp = (event, dataKey) => {
		if (!this.isHeaderMouseUp || event.button !== 0) {
			this.isHeaderMouseUp = true;
			return;
		}
		this.props.onHeaderClick(
			this.props.columns.findIndex(column => column.dataKey == dataKey));
	}

	_findColumnDragPosition(x) {
		const headerRect = document.querySelector(`#${this.props.id} .virtualized-table-header`).getBoundingClientRect();
		
		let coords = Array.from(document.querySelectorAll(`#${this.props.id} .virtualized-table-header .resizer`))
			.map((elem) => {
				const rect = elem.getBoundingClientRect();
				// accounting for resizer offset
				return rect.x + rect.width/2;
			});
		// Adding leftmost position, since there's no left resizer
		coords.splice(0, 0, headerRect.x);
		// and the rightmost position for the same reason
		coords.push(headerRect.x + headerRect.width);
		
		let index = 0;
		let closestVal = Math.abs(coords[index] - x);
		for (let i = 1; i < coords.length; i++) {
			let distance = Math.abs(coords[i] - x);
			if (distance < closestVal) {
				closestVal = distance;
				index = i;
			}
		}
		return {index, offsetX: coords[index] - headerRect.x};
	}

	componentDidMount() {
		this._jsWindow = new JSWindow(this._getJSWindowOptions());
		this.props.treeboxRef(this._jsWindow);
		this._jsWindow.initialize();
		this._jsWindow.render();
	}
	
	_getJSWindowOptions() {
		return {
			getItemCount: this.props.getRowCount,
			itemHeight: this.props.rowHeight,
			renderItem: this._renderItem,
			targetElement: document.getElementById(this._jsWindowID),
		};
	}

	_renderItem = (index) => {
		let node = this.props.renderItem(index, this.selection);
		node.addEventListener('mousedown', e => this._onMouseDown(e, index), { passive: true });
		node.addEventListener('dblclick', e => this._activateNode(e, [index]), { passive: true });
		return node;
	}

	_renderHeaderCells = () => {
		return this.props.columns.filter(col => !col.hidden).map((column, index) => {
			if (column.hidden) return;
			let label = this.props.intl.formatMessage({ id: column.label });
			if (column.iconLabel) {
				label = column.iconLabel;
			}
			let resizer = (<Draggable
				onDragStart={this._handleResizerDragStart.bind(this, index)}
				onDrag={this._handleResizerDrag}
				onDragStop={this._handleResizerDragStop}
				className={`resizer ${column.dataKey}`}
				key={column.label + '-resizer'}>
				<div/>
			</Draggable>);
			if (index == 0) {
				resizer = "";
			}
			let sortIndicator = "";
			if (!column.iconLabel && column.sortDirection) {
				sortIndicator = <span className={"sort-indicator " + (column.sortDirection === 1 ? "ascending" : "descending")}/>;
			}
			return (<Draggable
				onDragStart={this._handleColumnDragStart.bind(this, index)}
				onDrag={this._handleColumnDrag}
				onDragStop={this._handleColumnDragStop}
				className={cx("cell " + column.className, { dragging: this.state.dragging == index })}
				delay={500}
				key={column.label + '-draggable'}>
				<div
					key={column.label + ''}
					onMouseUp={e => this._handleHeaderMouseUp(e, column.dataKey)}>
					{resizer}
					<span
						key={column.label + '-label'}
						label={label}
						className={`label ${column.dataKey}`}>
						{label}
					</span>
					{sortIndicator}
				</div>
			</Draggable>);
		});
	}
		
	render() {
		let headerCells = this._renderHeaderCells();
		let dragMarker = "";
		if (typeof this.state.dragX == 'number') {
			dragMarker = <div className="column-drag-marker" style={{ left: this.state.dragX }} />;
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
			tabIndex: -1,
		};
		return (
			<div {...props}>
				{dragMarker}
				<div
					className="virtualized-table-header"
					onContextMenu={this.props.onColumnPickerMenu}>
					{headerCells}
				</div>
				<div {...jsWindowProps} />
			</div>
		);
	}
	
	updateTreebox() {
		if (!this._jsWindow) return;
		this._jsWindow.update(this._getJSWindowOptions());
	}
	
	invalidate() {
		if (!this._jsWindow) return;
		this._jsWindow.invalidate();
		this.updateWidth();
	}
	
	rerender() {
		if (!this._jsWindow) return;
		this._jsWindow.render();
		this.updateWidth();
	}
	
	updateWidth() {
		const jsWindow = document.querySelector(`#${this._jsWindowID} .js-window`);
		if (!jsWindow) return;
		const tree = document.querySelector(`#${this.props.id}`);
		const header = document.querySelector(`#${this.props.id} .virtualized-table-header`);
		const scrollbarWidth = Math.max(0,
			tree.getBoundingClientRect().width - jsWindow.getBoundingClientRect().width - 4);
		header.style.width = `calc(100% - ${scrollbarWidth}px)`;
	}
	
	invalidateRow(index) {
		if (!this._jsWindow) return;
		this._jsWindow.rerenderItem(index);
	}
	
	invalidateRange(startIndex, endIndex) {
		if (!this._jsWindow) return;
		for (; startIndex <= endIndex; startIndex++) {
			this._jsWindow.rerenderItem(startIndex);
		}
	}

	/**
	 * When performing custom event handling on rendered rows this allows to ensure that the
	 * focus returns to the virtualized table for kb selection and other event handling
	 */
	focus() {
		setTimeout(() => this._topDiv.focus());
	}
}

module.exports = injectIntl(VirtualizedTable, { forwardRef: true });
