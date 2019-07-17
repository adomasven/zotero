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

'use strict';
'use strict'

const React = require('react');
const { PureComponent } = React;
const { createDragHandler } = require('./utils');
const { func, string, number, node } = require('prop-types');
const cx = require('classnames');

const DRAG = { START: 1, ACTIVE: 2, NONE: 3 };

class Draggable extends PureComponent {
	componentWillUnmount() {
		this.drag.stop();
	}

	handleMouseDown = (event) => {
		if (this.dragstate > DRAG.NONE) this.drag.stop();
		if (event.button !== 0) return;

		if (this.props.onDragStart) {
			if (this.props.onDragStart(event)) return;
		}

		this.dragstate = DRAG.START;
		this.drag.start();

		const { pageX, pageY, clientX } = event;

		if (this.props.delay > 0) {
			this.delay = setTimeout(() => this.handleDrag({ pageX, pageY, clientX }),
				this.props.delay);
		}
	}

	handleDrag = (event) => {
		this.dragstate = DRAG.ACTIVE;
		this.clear();
		this.props.onDrag(event);
	}

	handleDragStop = (event, hasBeenCancelled) => {
		try {
			switch (this.dragstate) {
			case DRAG.START:
				this.props.onDragStop(event, true);
				break;
			case DRAG.ACTIVE:
				this.props.onDragStop(event, hasBeenCancelled);
				break;
			}
		}
		finally {
			this.clear();
			this.dragstate = DRAG.NONE;
		}
	}

	drag = createDragHandler({
		handleDrag: this.handleDrag,
		handleDragStop: this.handleDragStop
	})

	clear() {
		if (this.delay) clearTimeout(this.delay);
		this.delay = null;
	}

	render() {
		return (
			<div
				className={cx('draggable', this.props.className)}
				onMouseDown={this.handleMouseDown}>
				{this.props.children}
			</div>
		)
	}

	static propTypes = {
		children: node,
		className: string,
		delay: number,
		onDrag: func.isRequired,
		onDragStart: func.isRequired,
		onDragStop: func.isRequired
	}

	static defaultProps = {
		delay: 0,
	}
}

module.exports = Draggable;
