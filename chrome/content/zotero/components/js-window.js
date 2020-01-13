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

const requiredOptions = ['itemCount', 'itemHeight', 'renderItem', 'targetElement'];

module.exports = class {
	constructor(options) {
		for (let option of requiredOptions) {
			if (!options.hasOwnProperty(option)) {
				throw new Error('Attempted to initialize js-window without a required option: ' + option);
			}
		}
		
		this.scrollDirection = 0;
		this.scrollOffset = 0;
		this.overscanCount = 6;
		
		Object.assign(this, options);
		this._renderedRows = new Map();
	}
	
	initialize() {
		const { targetElement } = this;
		this.innerElem = document.createElementNS("http://www.w3.org/1999/xhtml", 'div');
		this.innerElem.className = "js-window";

		targetElement.appendChild(this.innerElem);
		targetElement.addEventListener('scroll', this._handleScroll);
		
		this.update();
	}
	
	destroy() {
		this.targetElement.removeEventListener('scroll', this._handleScroll);
	}
	
	rerenderItem(index) {
		if (!this._renderedRows.has(index)) return;
		let elem = this.renderItem(index);
		elem.style.top = this._getItemPosition(index) + "px";
		elem.style.position = "absolute";
		this.innerElem.replaceChild(elem, this._renderedRows.get(index));
		this._renderedRows.set(index, elem);
	}

	invalidate() {
		for (let elem of this._renderedRows.values()) {
			elem.remove();
		}
		this._renderedRows = new Map();
		this.render();
	}
	
	render() {
		const {
			renderItem,
			itemCount,
			innerElem,
		} = this;

		const [startIndex, stopIndex] = this._getRangeToRender();

		if (itemCount > 0) {
			for (let index = startIndex; index <= stopIndex; index++) {
				if (this._renderedRows.has(index)) continue;
				let elem = renderItem(index);
				elem.style.top = this._getItemPosition(index) + "px";
				elem.style.position = "absolute";
				innerElem.appendChild(elem);
				this._renderedRows.set(index, elem);
			}
		}
		for (let [index, elem] of this._renderedRows.entries()) {
			if (index < startIndex || index > stopIndex) {
				elem.remove();
				this._renderedRows.delete(index);
			}
		}
	}
	
	update(options = {}) {
		Object.assign(this, options);
		const { itemHeight, itemCount, targetElement, innerElem } = this;
		innerElem.style.cssText = `
			position: relative;
			height: ${itemHeight * itemCount}px;
		`;

		targetElement.style.cssText += `
			max-width: 100%;
			overflow: auto;
		`;

		this.scrollDirection = 0;
		this.scrollOffset = targetElement.scrollTop;
	}
	
	scrollTo(scrollOffset) {
		scrollOffset = Math.max(0, scrollOffset);
		this.scrollOffset = scrollOffset;
		this.targetElement.scrollTop = scrollOffset;
		this.render();
	}

	scrollToItem(index) {
		const { itemCount, itemHeight, scrollOffset, targetElement } = this;
		const height = targetElement.getBoundingClientRect().height;

		index = Math.max(0, Math.min(index, itemCount - 1));
		let startPosition = this._getItemPosition(index);
		let endPosition = startPosition + itemHeight;
		if (startPosition < scrollOffset) {
			this.scrollTo(startPosition);
		}
		else if (endPosition > scrollOffset + height) {
			this.scrollTo(Math.min(endPosition - height, (itemCount * itemHeight) - height));
		}
	}
	
	getFirstVisibleRow() {
		return Math.ceil(this.scrollOffset / this.itemHeight);
	}
	
	getLastVisibleRow() {
		const height = this.targetElement.getBoundingClientRect().height;
		return Math.max(1, Math.floor((this.scrollOffset + height + 1) / this.itemHeight)) - 1;
	}
	
	getPageLength() {
		const height = this.targetElement.getBoundingClientRect().height;
		return Math.ceil(height / this.itemHeight);
	}

	_getItemPosition = (index) => {
		return (this.itemHeight * index);
	};

	_getRangeToRender() {
		const { itemCount, itemHeight, targetElement, overscanCount, scrollDirection, scrollOffset } = this;
		const height = targetElement.getBoundingClientRect().height;

		if (itemCount === 0) {
			return [0, 0, 0, 0];
		}

		const startIndex = Math.floor(scrollOffset / itemHeight);
		const stopIndex = Math.ceil((scrollOffset + height) / itemHeight);

		// Overscan by one item in each direction so that tab/focus works.
		// If there isn't at least one extra item, tab loops back around.
		const overscanBackward =
			!scrollDirection || scrollDirection === -1
				? Math.max(1, overscanCount)
				: 1;
		const overscanForward =
			!scrollDirection || scrollDirection === 1
				? Math.max(1, overscanCount)
				: 1;

		return [
			Math.max(0, startIndex - overscanBackward),
			Math.max(0, Math.min(itemCount - 1, stopIndex + overscanForward)),
			startIndex,
			stopIndex,
		];
	}
	
	_handleScroll = (event) => {
		const { scrollOffset: prevScrollOffset } = this;
		const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
		
		if (prevScrollOffset === scrollTop) {
			// Scroll position may have been updated by cDM/cDU,
			// In which case we don't need to trigger another render,
			// And we don't want to update anything.
			return;
		}

		// Prevent macOS elastic scrolling from causing visual shaking when scrolling past bounds.
		const scrollOffset = Math.max(
			0,
			Math.min(scrollTop, scrollHeight - clientHeight)
		);

		this.scrollDirection = prevScrollOffset < scrollOffset ? 1 : -1;
		this.scrollOffset = scrollOffset;
		this._resetScrollDirection();
		this.render();
	};

	_resetScrollDirection = Zotero.Utilities.debounce(() => this.scrollDirection = 0, 150);
};
