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

Connecting AI apps to Zotero by adding zotero-mcp-stdio to their MCP configuration. Which apps
these are, and where their configuration is, is in Zotero.MCP.Apps.

Connecting adds a server named "zotero" whose command is the installed binary
(Zotero.MCP.getBinaryPath()). An app counts as connected if any of its servers runs
zotero-mcp-stdio, however it was added, so connecting never adds a second entry. Zotero only
writes configuration when the user clicks Connect or Disconnect, and edits only its own entry,
keeping the rest of the file, including comments, as it was.

*/

Zotero.MCP.AppConfig = new function () {
	const SERVER_NAME = 'zotero';
	const BINARY_BASENAME = 'zotero-mcp-stdio';
	
	this.STATUS_NOT_INSTALLED = 'notInstalled';
	this.STATUS_NOT_CONNECTED = 'notConnected';
	this.STATUS_CONNECTED = 'connected';
	// Has a different server named "zotero"
	this.STATUS_CONFLICT = 'conflict';
	
	// The latest edit of each file, so edits of one file run one at a time
	let _edits = new Map();
	
	/**
	 * @return {Promise<String>} The file holding the app's MCP servers: the first of its
	 *     configuration files that exists, or else the first
	 */
	this.getConfigPath = async function (app) {
		let paths = [app.config].flat();
		for (let path of paths) {
			if (await IOUtils.exists(path)) {
				return path;
			}
		}
		return paths[0];
	};
	
	/**
	 * @return {Promise<String>} One of the STATUS_ constants
	 * @throws If the app's configuration exists but can't be read
	 */
	this.getStatus = async function (app) {
		if (!app.config || !await Zotero.MCP.Apps.isInstalled(app)) {
			return this.STATUS_NOT_INSTALLED;
		}
		let text = await readText(await this.getConfigPath(app));
		return getStatusOf(readServers(app, text));
	};
	
	/**
	 * Add zotero-mcp-stdio to the app's configuration
	 */
	this.connect = async function (app) {
		if (!app.config || !await Zotero.MCP.Apps.isInstalled(app)) {
			throw new Error(`Can't connect ${app.id}: it isn't installed`);
		}
		let command = Zotero.MCP.getBinaryPath();
		if (!await IOUtils.exists(command)) {
			throw new Error(`${command} isn't installed`);
		}
		await editConfig(app, (text) => {
			let servers = readServers(app, text);
			let status = getStatusOf(servers);
			if (status == this.STATUS_CONNECTED) {
				return text;
			}
			if (status != this.STATUS_NOT_CONNECTED) {
				throw new Error(`Can't connect ${app.id}: ${status}`);
			}
			text ??= '';
			let edited;
			if (app.format == 'codexToml') {
				edited = text;
				if (edited && !edited.endsWith('\n')) {
					edited += '\n';
				}
				// A JSON string is a valid TOML basic string
				edited += `${edited ? '\n' : ''}[mcp_servers.${SERVER_NAME}]\n`
					+ `command = ${JSON.stringify(command)}\n`
					+ 'args = []\n';
			}
			else {
				if (!text.trim() && app.initial) {
					text = JSON.stringify(app.initial, null, 2) + '\n';
				}
				let keys = [app.key].flat();
				// Checks the result itself
				return Zotero.MCP.JSONC.setMember(text, keys, SERVER_NAME, app.entry(command));
			}
			let expected = [...servers, { name: SERVER_NAME, isOurs: true }];
			if (JSON.stringify(readServers(app, edited)) != JSON.stringify(expected)) {
				throw new Error('Editing settings produced unexpected data');
			}
			return edited;
		});
	};
	
	/**
	 * Remove every zotero-mcp-stdio server from the app's configuration
	 */
	this.disconnect = async function (app) {
		await editConfig(app, (text) => {
			if (text === null) {
				return text;
			}
			let servers = readServers(app, text);
			let edited = text;
			if (app.format == 'codexToml') {
				let ours = servers.filter(server => server.isOurs).map(server => server.name);
				edited = splitTOMLTables(text)
					// Comments at the end of a table are above the next one, and belong to it
					.map(table => (ours.includes(table.server) ? getTrailingComments(table.text) : table.text))
					.join('');
			}
			else {
				for (let server of servers) {
					if (server.isOurs) {
						// Checks the result itself
						edited = Zotero.MCP.JSONC.removeMember(edited, [app.key].flat(), server.name);
					}
				}
				return edited;
			}
			let expected = servers.filter(server => !server.isOurs);
			if (JSON.stringify(readServers(app, edited)) != JSON.stringify(expected)) {
				throw new Error('Editing settings produced unexpected data');
			}
			return edited;
		});
	};
	
	/**
	 * Edit the app's configuration file, one edit of a file at a time. The edit is made to the
	 * text as read and only written if the file still has that text, so a change another
	 * program makes in the meantime isn't lost. A file that changed throws.
	 *
	 * @param {Function} edit - Gets the text, or null if there's no file, and returns the
	 *     edited text
	 */
	async function editConfig(app, edit) {
		let path = await Zotero.MCP.AppConfig.getConfigPath(app);
		let previous = _edits.get(path) ?? Promise.resolve();
		let current = previous.catch(() => {}).then(async () => {
			let text = await readText(path);
			let edited = edit(text);
			if (edited === text) {
				return;
			}
			if (await readText(path) !== text) {
				throw new Error(`${path} was changed by another program while Zotero edited it`);
			}
			await writeText(path, edited);
		});
		_edits.set(path, current);
		let done = () => {
			if (_edits.get(path) == current) {
				_edits.delete(path);
			}
		};
		current.then(done, done);
		return current;
	}
	
	function getStatusOf(servers) {
		if (servers.some(server => server.isOurs)) {
			return Zotero.MCP.AppConfig.STATUS_CONNECTED;
		}
		if (servers.some(server => server.name == SERVER_NAME)) {
			return Zotero.MCP.AppConfig.STATUS_CONFLICT;
		}
		return Zotero.MCP.AppConfig.STATUS_NOT_CONNECTED;
	}
	
	/**
	 * @param {String|null} text - The configuration file's text, or null if there's no file
	 * @return {Object[]} The app's MCP servers, as { name, isOurs }
	 */
	function readServers(app, text) {
		if (text === null) return [];
		if (app.format == 'codexToml') {
			let servers = new Map();
			for (let table of splitTOMLTables(text)) {
				if (table.server === null) continue;
				let server = servers.get(table.server) ?? { name: table.server, isOurs: false };
				server.isOurs ||= isOurCommand(table.command);
				servers.set(table.server, server);
			}
			return [...servers.values()];
		}
		let servers = Zotero.MCP.JSONC.parse(text);
		for (let key of [app.key].flat()) {
			servers = servers?.[key];
		}
		if (!servers || typeof servers != 'object') return [];
		return Object.entries(servers).map(([name, server]) => ({
			name,
			isOurs: isOurCommand(server?.command),
		}));
	}
	
	function isOurCommand(command) {
		// opencode gives the command and arguments as one array
		if (Array.isArray(command)) {
			command = command[0];
		}
		if (typeof command != 'string') return false;
		let basename = command.split(/[/\\]/).pop().replace(/\.exe$/i, '');
		return basename == BINARY_BASENAME;
	}
	
	// A part of a TOML key: bare, "basic" or 'literal'
	const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
	// A dotted TOML key
	const TOML_KEY = String.raw`${TOML_KEY_PART}(?:[ \t]*\.[ \t]*${TOML_KEY_PART})*`;
	const TOML_HEADER = new RegExp(String.raw`^[ \t]*(\[\[?)[ \t]*(${TOML_KEY})[ \t]*(\]\]?)[ \t]*(?:#.*)?\r?\n?$`);
	const TOML_KEY_VALUE = new RegExp(String.raw`^[ \t]*(${TOML_KEY})[ \t]*=[ \t]*(.*)$`, 's');
	
	/**
	 * Split Codex's config.toml into tables at their headers, keeping the text of each as is.
	 * Tables of a server, i.e. [mcp_servers.<name>] and subtables such as
	 * [mcp_servers.<name>.env], have the server's name, and [mcp_servers.<name>] its command.
	 * Codex's MCP servers are understood only as such tables; servers defined any other way,
	 * e.g. as inline tables or dotted keys, throw, so Zotero doesn't add a second "zotero" or
	 * cut a table in two.
	 *
	 * @return {Object[]} [{ text, server (name, or null), command }]
	 */
	function splitTOMLTables(text) {
		let tables = [{ text: '', path: [], server: null }];
		// What continues onto the next line: a multi-line string, and open arrays and inline
		// tables
		let state = { string: null, depth: 0 };
		for (let line of text.split(/(?<=\n)/)) {
			if (!state.string && !state.depth) {
				let header = line.match(TOML_HEADER);
				let keyValue = !header && line.match(TOML_KEY_VALUE);
				if (header) {
					if (header[1].length != header[3].length) {
						throw new Error(`Unexpected TOML header: ${line.trim()}`);
					}
					let path = parseTOMLKey(header[2]);
					if (path[0] == 'mcp_servers' && header[1] == '[[') {
						throw new Error('Unexpected array of tables in mcp_servers');
					}
					tables.push({
						text: '',
						path,
						server: path[0] == 'mcp_servers' && path.length >= 2 ? path[1] : null,
					});
				}
				else if (keyValue) {
					let table = tables[tables.length - 1];
					let path = [...table.path, ...parseTOMLKey(keyValue[1])];
					if (path[0] == 'mcp_servers' && table.path.length < 2) {
						throw new Error('MCP servers are defined in a form Zotero doesn\'t edit');
					}
					if (table.path.length == 2 && table.server !== null
							&& path.length == 3 && path[2] == 'command') {
						let value = keyValue[2].match(/^("(?:[^"\\]|\\.)*"|'[^']*')/);
						if (value) {
							try {
								table.command = value[1][0] == "'" ? value[1].slice(1, -1) : JSON.parse(value[1]);
							}
							catch {}
						}
					}
				}
				else if (/^[ \t]*\[/.test(line)) {
					throw new Error(`Unexpected TOML header: ${line.trim()}`);
				}
			}
			tables[tables.length - 1].text += line;
			scanTOMLLine(line, state);
		}
		if (state.string || state.depth) {
			throw new Error('Unexpected end of TOML');
		}
		return tables;
	}
	
	function getTrailingComments(text) {
		let lines = text.split(/(?<=\n)/);
		let rest = lines.slice(lines.findLastIndex(line => line.trim() && !line.trim().startsWith('#')) + 1);
		let first = rest.findIndex(line => line.trim());
		return first == -1 ? '' : rest.slice(first).join('');
	}
	
	/**
	 * @return {String[]} The parts of a dotted TOML key
	 */
	function parseTOMLKey(key) {
		return key.match(new RegExp(TOML_KEY_PART, 'g')).map((part) => {
			if (part[0] == "'") {
				return part.slice(1, -1);
			}
			if (part[0] == '"') {
				// TOML's escapes, apart from \U and \e, are JSON's
				return JSON.parse(part);
			}
			return part;
		});
	}
	
	/**
	 * Follow the strings, arrays and inline tables in a line of TOML, so lines inside them
	 * aren't taken for headers or keys
	 */
	function scanTOMLLine(line, state) {
		for (let i = 0; i < line.length; i++) {
			let c = line[i];
			if (state.string) {
				if (c == '\\' && state.string[0] == '"') {
					i++;
				}
				else if (line.startsWith(state.string, i)) {
					i += state.string.length - 1;
					// """a"""" is a" -- up to two more quotes belong to the string
					for (let extra = 0; extra < 2 && state.string.length == 3 && line[i + 1] == c; extra++) {
						i++;
					}
					state.string = null;
				}
				continue;
			}
			if (c == '#') {
				break;
			}
			if (c == '"' || c == "'") {
				state.string = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
				i += state.string.length - 1;
			}
			else if (c == '[' || c == '{') {
				state.depth++;
			}
			else if (c == ']' || c == '}') {
				state.depth--;
			}
		}
		// Only multi-line strings continue onto the next line
		if (state.string?.length == 1) {
			throw new Error('Unterminated TOML string');
		}
	}
	
	async function readText(path) {
		try {
			return await IOUtils.readUTF8(path);
		}
		catch (e) {
			if (DOMException.isInstance(e) && e.name == 'NotFoundError') {
				return null;
			}
			throw e;
		}
	}
	
	/**
	 * Replace the file with the text, so the app never reads a partly written file. The
	 * replacement keeps the file's permissions, since settings can include API keys, and a
	 * new file is readable only by the user.
	 */
	async function writeText(path, text) {
		let file = Zotero.File.pathToFile(path);
		// Replace the target of a link (e.g. into a dotfiles repository), not the link
		if (file.exists() && file.isSymlink()) {
			path = file.target;
		}
		let permissions = 0o600;
		try {
			permissions = (await IOUtils.stat(path)).permissions;
		}
		catch (e) {
			if (!(DOMException.isInstance(e) && e.name == 'NotFoundError')) {
				throw e;
			}
		}
		await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
		let tmpPath = path + '.zotero-tmp';
		// Set the permissions before writing anything
		await IOUtils.writeUTF8(tmpPath, '');
		await IOUtils.setPermissions(tmpPath, permissions, false);
		await IOUtils.writeUTF8(tmpPath, text, { flush: true });
		await IOUtils.move(tmpPath, path);
	}
};
