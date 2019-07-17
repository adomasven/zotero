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
const { FixedSizeList: List } = require('react-window');
const { injectIntl } = require('react-intl');
const VirtualizedTree = require('./virtualized-tree');
const cx = require('classnames');
const Draggable = require('react-draggable').DraggableCore;

class VirtualizedTable extends VirtualizedTree {
	constructor(props) {
		super(props);
		this.state = {
			columns: props.columns.filter(c => !c.hidden),
			resizing: null
		};
		this._resizingColumn = null;
	}
	
	_handleResizerDragStart(index, event) {
		if (event.button !== 0) return;

		this._resizingColumn = event.target.nextSibling;
		this.setState({ resizing: index });
	}

	_handleResizerDrag = (event) => {
		event.stopImmediatePropagation();
		const index = this.state.resizing;
		const b = this._resizingColumn;
		const a = b.previousSibling.previousSibling;
		const offset = a.getBoundingClientRect().x;
		const widthSum = a.clientWidth + b.clientWidth;
		const columns = this.state.columns;
		// At least 20px per column
		columns[index - 1].width = Math.min(widthSum - 20, Math.max(20, event.clientX - offset));
		columns[index].width = widthSum - columns[index - 1].width;
		let onResizeData = {};
		onResizeData[columns[index - 1].dataKey] = columns[index - 1].width;
		onResizeData[columns[index].dataKey] = columns[index].width;
		this.props.onColumnResize(onResizeData);
	}

	_handleResizerDragStop = (event) => {
		this._resizingColumn = null;
		this.setState({ resizing: null });
	}
	
	_getColumns = () => {
		let columns = [];
		let defaultColumnWidth = this.props.container.clientWidth / this.state.columns.length;
		this.state.columns.forEach((column, index) => {
			let cellRenderer = defaultTableCellRenderer;
			if (column.primary) {
				cellRenderer = this.props.primaryCellRenderer;
			}
			let headerRenderer = defaultTableHeaderRenderer;
			// No resizer for the first column
			if (columns.length) {
				headerRenderer = reactVirtualizedProps =>
					this._renderResizableHeaderCell(reactVirtualizedProps, index);
			}
			columns.push(<Column
				dataKey={column.dataKey}
				label={this.props.intl.formatMessage({ id: column.label })}
				flexGrow={column.flex}
				width={column.width || defaultColumnWidth}
				cellRenderer={cellRenderer}
				headerRenderer={headerRenderer}
			/>);
		});
		return columns;
	}
	
	_renderResizableHeaderCell = ({ dataKey, label, sortBy, sortDirection }, index) => {
		const showSortIndicator = sortBy === dataKey;
		let children = [
			<Draggable
				enableUserSelectHack={false}
				onStart={this._handleResizerDragStart.bind(this, index)}
				onDrag={this._handleResizerDrag}
				onStop={this._handleResizerDragStop}>
				<div className="resizer"/>
			</Draggable>,
			<span
				className="cell"
				key="label"
				title={typeof label === 'string' ? label : null}>
				{label}
			</span>
		];

		if (showSortIndicator) {
			children.push(
				'/\\'
			);
		}

		return children;
	}

	render() {
		// if (this.selection.pivot >= this.props.rowCount) {
		// 	this.selection.pivot = this.props.rowCount - 1;
		// }
		// let rowRendererArgs = {
		// 	selection: this.selection,
		// };
		// let props = {
		// 	rowRenderer: (reactVirtualizedObj) => {
		// 		return (<div onMouseDown={e => this._onMouseDown(e, reactVirtualizedObj.index)}>
		// 			{this.props.rowRenderer(reactVirtualizedObj, rowRendererArgs)}
		// 		</div>);
		// 	},
		// 	// headerRowRenderer: ({ style, columns, className }) => {
		// 	// 	return (
		// 	// 		<div
		// 	// 			className={className}
		// 	// 			style={style}
		// 	// 			onContextMenu={this.props.onColumnPickerMenu}>
		// 	// 			{columns}
		// 	// 			<div
		// 	// 				className={"ReactVirtualized__Table__headerColumn column-picker"}
		// 	// 				style={{ flex: "0 0 20px" }}
		// 	// 				onMouseDown={this.props.onColumnPickerMenu}>
		// 	// 				[]
		// 	// 			</div>
		// 	// 		</div>
		// 	// 	);
		// 	// },
		// 	rowGetter: this.props.rowGetter,
		// 	ref: this._listRef,
		// 	containerProps: {
		// 		onClick: (e) => {
		// 			if (!this.props.editing && this.props.id && e.target.id == this.props.id) {
		// 				// Focus should always remain on the tree container itself.
		// 				e.target.focus();
		// 			}
		// 		},
		// 		onKeyDown: this._onKeyDown,
		// 		onDragOver: this._onDragOver,
		// 		"aria-label": this.props.label,
		// 		"aria-labelledby": this.props.labelledby,
		// 		"aria-activedescendant": this.props.rowCount && this.props.getAriaLabel
		// 			&& this.props.getAriaLabel(this.selection.pivot),
		// 	},
		// 	children: this._getColumns(),
		// 	headerHeight: 28
		// };
		// if (!Zotero.isElectron) {
		// 	// N.B. Reduces the rendering performance while scrolling but removes the
		// 	// delay between scrolling and clicking
		// 	// See https://github.com/bvaughn/react-virtualized/issues/564#issuecomment-277789650
		// 	// Related to requestAnimationFrame not being available in required modules within XUL
		// 	// See https://github.com/bvaughn/react-virtualized/pull/742
		// 	// Untested in React, but should not be required
		// 	props.containerStyle = {
		// 		pointerEvents: "auto"
		// 	};
		// }
		// for (let key of ['width', 'height', 'autoWidth', 'autoHeight', 'id',
		// 			'className', 'rowCount', 'rowHeight', 'headerHeight']) {
		// 	if (key in this.props) {
		// 		props[key] = this.props[key];
		// 	}
		// }
		// props.className = (props.className || "") + ' tree';
		// if (this.state.resizing) {
		// 	props.className += ' resizing';
		// }
		let columns = this.state.columns.map((column, index) => {
			let width = column.width;
			let label = this.props.intl.formatMessage({ id: column.label });
			return (<React.Fragment key={label + 'column'}>
				<Draggable
					enableUserSelectHack={false}
					onStart={this._handleResizerDragStart.bind(this, index)}
					onDrag={this._handleResizerDrag}
					onStop={this._handleResizerDragStop}
					key={label + '-resizer'}>
					<div className="resizer"/>
				</Draggable>
				<span
					className={"cell " + column.className}
					key={label}>
					{label}
				</span>
			</React.Fragment>);
		});
		let props = {
			className: 'virtualized-table-body',
			height: this.props.height,
			itemCount: this.props.rowCount,
			itemSize: this.props.rowHeight,
			itemData: this.state.columns,
			itemKey: this.props.itemKey,
			width: "100%",
			children: this.props.children,
		};
		let classes = cx(["virtualized-table", { resizing: this.state.resizing }]);
		return (
			<div className={classes}>
				<div className="virtualized-table-header">{columns}</div>
				<List {...props}/>
			</div>
		);
	}
}

module.exports = injectIntl(VirtualizedTable, { forwardRef: true });
