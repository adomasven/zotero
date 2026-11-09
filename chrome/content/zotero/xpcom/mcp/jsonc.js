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

/*

Reading and editing AI apps' JSON settings files, which may contain comments and trailing
commas (JSONC, as in VS Code, Zed and Gemini CLI).

Edits change only the text of the member being added or removed, so the rest of the file,
including comments and formatting, stays as it was. Each edit is checked by parsing the result
and comparing it with the expected data, and throws rather than return text that doesn't parse
to exactly that.

*/

Zotero.MCP.JSONC = new function () {
	/**
	 * @param {String} text
	 * @return {any} The value, or undefined if the text is empty
	 * @throws {SyntaxError}
	 */
	this.parse = function (text) {
		let node = parseDocument(text);
		return node ? toValue(node) : undefined;
	};
	
	/**
	 * Set root[path...][name] = value, creating objects along the path as needed
	 *
	 * @param {String} text
	 * @param {String[]} path - Keys of the object holding the member, from the root
	 * @param {String} name
	 * @param {any} value - JSON-serializable
	 * @return {String} The edited text
	 */
	this.setMember = function (text, path, name, value) {
		let root = parseDocument(text);
		let expected = root ? toValue(root) : {};
		getOrCreate(expected, path)[name] = value;
		let result;
		if (!root) {
			// Keep a file of only comments, adding the object after them
			let comments = text.trimEnd();
			result = (comments ? comments + '\n' : '') + JSON.stringify(expected, null, 2) + '\n';
		}
		else {
			if (root.type != 'object') {
				throw new Error("Settings aren't a JSON object");
			}
			let indentUnit = detectIndentUnit(text);
			// Find the deepest existing object on the path
			let obj = root;
			let i = 0;
			for (; i < path.length; i++) {
				let key = path[i];
				let member = obj.members.find(m => m.key == key);
				if (!member) break;
				if (member.value.type != 'object') {
					throw new Error(`"${path.slice(0, i + 1).join('.')}" isn't an object`);
				}
				obj = member.value;
			}
			let existing = i == path.length && obj.members.find(m => m.key == name);
			if (existing) {
				let indent = lineIndent(text, existing.start);
				result = text.slice(0, existing.value.start)
					+ formatValue(value, indent, indentUnit)
					+ text.slice(existing.value.end);
			}
			else {
				// Wrap the value in objects for the missing part of the path
				let key = i == path.length ? name : path[i];
				let memberValue = i == path.length ? value : buildNested(path.slice(i + 1), name, value);
				result = insertMember(text, obj, key, memberValue, indentUnit);
			}
		}
		check(result, expected);
		return result;
	};
	
	/**
	 * Remove root[path...][name] if it exists
	 *
	 * @return {String} The edited text, or the same text if there was nothing to remove
	 */
	this.removeMember = function (text, path, name) {
		let root = parseDocument(text);
		if (!root || root.type != 'object') return text;
		let obj = root;
		for (let key of path) {
			let member = obj.members.find(m => m.key == key);
			if (!member || member.value.type != 'object') return text;
			obj = member.value;
		}
		let index = obj.members.findIndex(m => m.key == name);
		if (index == -1) return text;
		let expected = toValue(root);
		delete getOrCreate(expected, path)[name];
		
		let member = obj.members[index];
		let start = member.start;
		let end = member.value.end;
		let after = skipTrivia(text, end);
		if (text[after] == ',') {
			// Remove the member and its comma
			end = after + 1;
		}
		else if (index > 0) {
			// Last member: remove the previous member's comma instead
			let prev = obj.members[index - 1];
			let comma = skipTrivia(text, prev.value.end);
			if (text[comma] == ',') {
				text = text.slice(0, comma) + text.slice(comma + 1);
				start -= 1;
				end -= 1;
			}
			// Spaces before a member on a shared line
			while (start > 0 && (text[start - 1] == ' ' || text[start - 1] == '\t')
					&& text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim()) {
				start--;
			}
		}
		// Collapse an object left with nothing but whitespace
		if (obj.members.length == 1 && !text.slice(obj.start + 1, start).trim()
				&& !text.slice(end, obj.end - 1).trim()) {
			start = obj.start + 1;
			end = obj.end - 1;
		}
		// Remove the whole line if the member was alone on it
		let lineStart = text.lastIndexOf('\n', start - 1) + 1;
		if (!text.slice(lineStart, start).trim()) {
			let lineEnd = text.indexOf('\n', end);
			if (lineEnd == -1) lineEnd = text.length;
			if (!text.slice(end, lineEnd).trim()) {
				start = lineStart;
				end = lineEnd < text.length ? lineEnd + 1 : lineEnd;
			}
		}
		let result = text.slice(0, start) + text.slice(end);
		check(result, expected);
		return result;
	};
	
	function buildNested(path, name, value) {
		let result = { [name]: value };
		for (let j = path.length - 1; j >= 0; j--) {
			result = { [path[j]]: result };
		}
		return result;
	}
	
	function getOrCreate(obj, path) {
		for (let key of path) {
			if (!obj[key] || typeof obj[key] != 'object') {
				obj[key] = {};
			}
			obj = obj[key];
		}
		return obj;
	}
	
	function check(text, expected) {
		let actual;
		try {
			actual = Zotero.MCP.JSONC.parse(text);
		}
		catch (e) {
			throw new Error(`Editing settings produced invalid JSON: ${e.message}`);
		}
		if (!deepEqual(actual, expected)) {
			throw new Error('Editing settings produced unexpected data');
		}
	}
	
	function deepEqual(a, b) {
		if (a === b) return true;
		if (typeof a != 'object' || typeof b != 'object' || !a || !b) return false;
		if (Array.isArray(a) != Array.isArray(b)) return false;
		let keysA = Object.keys(a);
		let keysB = Object.keys(b);
		return keysA.length == keysB.length && keysA.every(key => deepEqual(a[key], b[key]));
	}
	
	/**
	 * Add a member at the end of an object, after any existing members and the comments on
	 * their line, indented like its siblings
	 */
	function insertMember(text, obj, key, value, indentUnit) {
		let objIndent = lineIndent(text, obj.start);
		let last = obj.members[obj.members.length - 1];
		if (last) {
			let indent = lineIndent(text, last.start);
			let memberText = JSON.stringify(key) + ': ' + formatValue(value, indent, indentUnit);
			let commaPos = skipTrivia(text, last.value.end);
			let insertAfter;
			if (text[commaPos] == ',') {
				// Trailing comma: keep it after the new member too
				insertAfter = commaPos + 1;
				memberText += ',';
			}
			else {
				text = text.slice(0, last.value.end) + ',' + text.slice(last.value.end);
				insertAfter = last.value.end + 1;
			}
			// After a comment on the same line, so it stays with its member
			let lineEnd = text.indexOf('\n', insertAfter);
			let restOfLine = text.slice(insertAfter, lineEnd == -1 ? text.length : lineEnd);
			if (lineEnd != -1 && isOnlyTrivia(restOfLine)) {
				return text.slice(0, lineEnd) + '\n' + indent + memberText + text.slice(lineEnd);
			}
			// Compact files stay compact
			memberText = memberText.replace(/:.*$/s, ': ' + JSON.stringify(value)) + (memberText.endsWith(',') ? ',' : '');
			return text.slice(0, insertAfter) + ' ' + memberText + text.slice(insertAfter);
		}
		let indent = objIndent + indentUnit;
		let memberText = JSON.stringify(key) + ': ' + formatValue(value, indent, indentUnit);
		let open = obj.start + 1;
		let close = obj.end - 1;
		let between = text.slice(open, close);
		if (between.includes('\n')) {
			// Keep comments inside the empty object before the new member
			let lastNewline = text.lastIndexOf('\n', close - 1);
			return text.slice(0, lastNewline) + '\n' + indent + memberText + text.slice(lastNewline);
		}
		// Keep comments in a one-line empty object, which can only be block comments
		let comments = between.trim();
		return text.slice(0, open) + (comments ? '\n' + indent + comments : '')
			+ '\n' + indent + memberText + '\n' + objIndent + text.slice(close);
	}
	
	function formatValue(value, indent, indentUnit) {
		return JSON.stringify(value, null, indentUnit).replace(/\n/g, '\n' + indent);
	}
	
	function lineIndent(text, pos) {
		let lineStart = text.lastIndexOf('\n', pos - 1) + 1;
		return text.slice(lineStart).match(/^[ \t]*/)[0];
	}
	
	function detectIndentUnit(text) {
		let match = text.match(/\n([ \t]+)\S/);
		return match ? match[1] : '  ';
	}
	
	function isOnlyTrivia(str) {
		try {
			return skipTrivia(str, 0) == str.length;
		}
		catch {
			// An unterminated block comment continues on the next line
			return false;
		}
	}
	
	/**
	 * @return {Integer} The position of the next character that isn't whitespace or a comment
	 */
	function skipTrivia(text, pos) {
		while (pos < text.length) {
			let c = text[pos];
			if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\uFEFF') {
				pos++;
			}
			else if (text.startsWith('//', pos)) {
				let end = text.indexOf('\n', pos);
				pos = end == -1 ? text.length : end;
			}
			else if (text.startsWith('/*', pos)) {
				let end = text.indexOf('*/', pos + 2);
				if (end == -1) throw new SyntaxError('Unterminated comment');
				pos = end + 2;
			}
			else {
				break;
			}
		}
		return pos;
	}
	
	// Parsing: nodes keep the source positions of each value and object member
	
	function parseDocument(text) {
		let pos = skipTrivia(text, 0);
		if (pos == text.length) return null;
		let [node, end] = parseValue(text, pos);
		if (skipTrivia(text, end) != text.length) {
			throw new SyntaxError(`Unexpected text at ${end}`);
		}
		return node;
	}
	
	function parseValue(text, pos) {
		let c = text[pos];
		if (c == '{') {
			let members = [];
			let p = skipTrivia(text, pos + 1);
			while (text[p] != '}') {
				if (text[p] != '"') throw new SyntaxError(`Expected a key at ${p}`);
				let [keyNode, keyEnd] = parseValue(text, p);
				let colon = skipTrivia(text, keyEnd);
				if (text[colon] != ':') throw new SyntaxError(`Expected ":" at ${colon}`);
				let [value, valueEnd] = parseValue(text, skipTrivia(text, colon + 1));
				members.push({ key: toValue(keyNode), start: p, value });
				p = skipTrivia(text, valueEnd);
				if (text[p] == ',') {
					p = skipTrivia(text, p + 1);
				}
				else if (text[p] != '}') {
					throw new SyntaxError(`Expected "," or "}" at ${p}`);
				}
			}
			return [{ type: 'object', start: pos, end: p + 1, members }, p + 1];
		}
		if (c == '[') {
			let items = [];
			let p = skipTrivia(text, pos + 1);
			while (text[p] != ']') {
				let [item, itemEnd] = parseValue(text, p);
				items.push(item);
				p = skipTrivia(text, itemEnd);
				if (text[p] == ',') {
					p = skipTrivia(text, p + 1);
				}
				else if (text[p] != ']') {
					throw new SyntaxError(`Expected "," or "]" at ${p}`);
				}
			}
			return [{ type: 'array', start: pos, end: p + 1, items }, p + 1];
		}
		let match = text.slice(pos).match(c == '"'
			? /^"(?:[^"\\\n]|\\.)*"/
			: /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
		if (!match) throw new SyntaxError(`Unexpected character at ${pos}`);
		let end = pos + match[0].length;
		return [{ type: 'literal', start: pos, end, value: JSON.parse(match[0]) }, end];
	}
	
	function toValue(node) {
		switch (node.type) {
			case 'object': {
				let obj = {};
				for (let member of node.members) {
					obj[member.key] = toValue(member.value);
				}
				return obj;
			}
			case 'array':
				return node.items.map(toValue);
			default:
				return node.value;
		}
	}
};
