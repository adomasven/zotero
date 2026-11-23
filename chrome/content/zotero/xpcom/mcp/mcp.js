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

MCP (Model Context Protocol) support, so AI apps can use the library.

AI apps launch zotero-mcp-stdio (https://github.com/zotero/zotero-mcp-stdio), a small stdio
MCP server bundled with Zotero. It serves the tool list from tools.json next to it and forwards
each tool call to the /mcp endpoint of the running Zotero (mcp/server.js).

On every launch, while MCP is enabled, Zotero:

- copies the bundled binary and resource://zotero/mcp/tools.json to a stable per-user directory
  (getBinDir()), so AI app configurations keep working when the app is moved or updated
- writes zotero-mcp.json into the profile directory, telling the binary which port to use and
  how to start Zotero when it isn't running

*/

Zotero.MCP = new function () {
	const SIDECAR_FILE = 'zotero-mcp.json';
	// Bump only for changes an older zotero-mcp-stdio would misread. Adding fields is fine.
	const SIDECAR_FORMAT = 1;
	const TOOLS_URL = 'resource://zotero/mcp/tools.json';
	
	this.PROTOCOL_VERSION = '2026-07-28';
	// Key in a tool's _meta in tools.json naming the permission it needs (see permissions.js).
	// Tools without one only read or act on the UI, and need none.
	this.PERMISSION_META = 'org.zotero/permission';
	this.BINARY_NAME = Zotero.isWin ? 'zotero-mcp-stdio.exe' : 'zotero-mcp-stdio';
	// How long one tool call may take in Zotero, from when it arrives: the permission dialog
	// and the handler's waits share it. Shorter than zotero-mcp-stdio's default call timeout
	// (50 s), which starts earlier, so the result reaches the AI app before the bridge gives up
	// on the call. Overridden in tests.
	// TODO: Return a task (the MCP Tasks extension) for calls that need longer, for AI apps
	// that support it
	this.CALL_BUDGET = 45 * 1000;
	
	// tools.json: { instructions, tools }
	let _toolsFile = null;
	// Argument validators, by tool name
	let _validators = new Map();
	
	// The latest install(), so the settings pane can wait for the binary
	this.installPromise = Promise.resolve();
	
	// Aborted when MCP is turned off, cancelling calls waiting for permission
	let _enabled = new AbortController();
	
	this.init = async function () {
		let install = () => {
			this.installPromise = this.install().catch(e => Zotero.logError(e));
			return this.installPromise;
		};
		Zotero.Prefs.registerObserver('mcp.enabled', (enabled) => {
			if (enabled) {
				install();
			}
			else {
				_enabled.abort();
				_enabled = new AbortController();
			}
		});
		if (Zotero.Prefs.get('mcp.enabled')) {
			await install();
		}
	};
	
	/**
	 * Show the dialog for editing an app's permissions, modal to `parent`
	 *
	 * @param {String} clientID
	 * @param {Window} parent
	 */
	this.openPermissionsWindow = function (clientID, parent) {
		// One set of permissions for all the names an app gives
		clientID = Zotero.MCP.Apps.getForClient(clientID)?.clientNames[0] ?? clientID;
		parent.openDialog(
			'chrome://zotero/content/mcpPermissions.xhtml',
			'',
			'chrome,modal,centerscreen',
			{ clientID }
		);
	};
	
	async function getToolsFile() {
		if (!_toolsFile) {
			_toolsFile = JSON.parse(await Zotero.File.getContentsFromURLAsync(TOOLS_URL));
		}
		return _toolsFile;
	}
	
	/**
	 * @return {Promise<Object[]>} MCP tool definitions from tools.json
	 */
	this.getTools = async function () {
		return (await getToolsFile()).tools;
	};
	
	/**
	 * Server instructions from tools.json: what the tools are for, for the model. Apps that
	 * load tool definitions only when the model searches for them show these up front.
	 *
	 * @return {Promise<String>}
	 */
	this.getInstructions = async function () {
		return (await getToolsFile()).instructions;
	};
	
	/**
	 * Directory that AI app configurations point at. Per user, outside the profile, so it
	 * survives app moves and updates. On Windows it's under %LOCALAPPDATA%, so roaming
	 * profiles don't carry an executable.
	 */
	this.getBinDir = function () {
		if (Zotero.isWin) {
			let localAppData = Services.dirsvc.get('LocalAppData', Ci.nsIFile).path;
			return PathUtils.join(localAppData, 'Zotero', 'bin');
		}
		// The directory containing profiles.ini
		return PathUtils.join(Services.dirsvc.get('UAppData', Ci.nsIFile).path, 'bin');
	};
	
	this.getBinaryPath = function () {
		return PathUtils.join(this.getBinDir(), this.BINARY_NAME);
	};
	
	this.getSidecarPath = function () {
		return PathUtils.join(Zotero.Profile.dir, SIDECAR_FILE);
	};
	
	/**
	 * Copy the binary and tools.json into the bin directory and write the sidecar file
	 */
	this.install = async function () {
		let binDir = this.getBinDir();
		await IOUtils.makeDirectory(binDir, { ignoreExisting: true });
		
		let bundledBinary = PathUtils.join(
			Services.dirsvc.get('XREExeF', Ci.nsIFile).parent.path,
			this.BINARY_NAME
		);
		if (await IOUtils.exists(bundledBinary)) {
			try {
				await copyIfChanged(bundledBinary, this.getBinaryPath(), { executable: true });
			}
			catch (e) {
				// On Windows, a running copy can't be replaced. The binary holds no Zotero
				// logic, so the old one keeps working with the new tools.json.
				Zotero.logError(e);
			}
		}
		else {
			Zotero.debug(`MCP: ${bundledBinary} not found -- not installing zotero-mcp-stdio`, 2);
		}
		await writeIfChanged(
			PathUtils.join(binDir, 'tools.json'),
			await Zotero.File.getContentsFromURLAsync(TOOLS_URL)
		);
		await this.writeSidecar();
	};
	
	this.writeSidecar = async function () {
		let port;
		try {
			port = Zotero.Server.port;
		}
		catch {
			Zotero.debug('MCP: HTTP server isn\'t running -- not writing ' + SIDECAR_FILE, 2);
			return;
		}
		let sidecar = {
			version: SIDECAR_FORMAT,
			zoteroVersion: Zotero.version,
			port,
			launch: getLaunchCommand(),
		};
		await IOUtils.writeJSON(this.getSidecarPath(), sidecar, {
			tmpPath: this.getSidecarPath() + '.tmp'
		});
	};
	
	/**
	 * Run a tool
	 *
	 * Asks for the permission the tool declares in tools.json first. For library permissions,
	 * that's for the library in the libraryID argument, by default My Library.
	 *
	 * Arguments that don't match the tool's inputSchema are reported to the model, so it can
	 * correct them.
	 *
	 * @param {String} name - A tool from tools.json, e.g. zotero_get_items, with a handler in
	 *     Zotero.MCP.Tools, e.g. getItems
	 * @param {Object} args - Arguments, as sent by the AI app
	 * @param {Object} context
	 * @param {String} context.clientID - The AI app's name, from its MCP clientInfo
	 * @return {Promise<Object>} An MCP CallToolResult
	 */
	this.callTool = async function (name, args, context) {
		let tool = (await this.getTools()).find(tool => tool.name === name);
		let handler = tool && Zotero.MCP.Tools[
			name.replace(/^zotero_/, '').replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
		];
		if (!handler) {
			throw new Error(`No handler for tool ${name}`);
		}
		let permission = tool._meta?.[this.PERMISSION_META];
		// For permissions a handler asks for itself, and its waits
		context = { ...context, signal: _enabled.signal, deadline: Date.now() + this.CALL_BUDGET };
		try {
			checkArguments(tool, args);
			if (permission) {
				let libraryID = null;
				if (permission != Zotero.MCP.Permissions.EDIT_SETTINGS) {
					libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;
					if (!Number.isInteger(libraryID) || !Zotero.Libraries.exists(libraryID)) {
						throw new this.ToolError(`No library ${libraryID}`);
					}
					if (!Zotero.Libraries.get(libraryID).editable) {
						throw new this.ToolError(`${Zotero.Libraries.get(libraryID).name} is read-only`);
					}
				}
				await Zotero.MCP.Permissions.require(context.clientID, permission, libraryID, context);
			}
			return await handler(args, context);
		}
		catch (e) {
			if (!(e instanceof this.ToolError)) {
				Zotero.logError(e);
			}
			return { content: [{ type: 'text', text: e.message }], isError: true };
		}
	};
	
	/**
	 * An error caused by the tool's input. Tool handlers throw it to report the message to
	 * the model as is.
	 */
	this.ToolError = class extends Error {};

	// What untilDeadline() gives when the deadline comes first
	this.TIMED_OUT = Symbol('timedOut');

	/**
	 * The promise's value, or TIMED_OUT if the deadline comes first. The work goes on, and an
	 * error after the deadline is logged.
	 *
	 * @param {Number} deadline - Date.now() time to stop waiting at
	 */
	this.untilDeadline = async function (promise, deadline) {
		let timedOut = false;
		promise.catch((e) => {
			if (timedOut) {
				Zotero.logError(e);
			}
		});
		let result = await Promise.race([
			promise,
			Zotero.Promise.delay(Math.max(0, deadline - Date.now())).then(() => Zotero.MCP.TIMED_OUT),
		]);
		timedOut = result === Zotero.MCP.TIMED_OUT;
		return result;
	};
	
	/**
	 * @param {String} text
	 * @return {Object} An MCP CallToolResult with one text block
	 */
	this.textResult = function (text) {
		return { content: [{ type: 'text', text }] };
	};
	
	/**
	 * @param {Object} value - Matching the tool's outputSchema
	 * @return {Object} An MCP CallToolResult with the value as structured content, and as JSON
	 *     text for apps that don't read structured content
	 */
	this.jsonResult = function (value) {
		// Without the undefined properties left out of the JSON
		let structuredContent = JSON.parse(JSON.stringify(value));
		return {
			content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
			structuredContent,
		};
	};
	
	/**
	 * @throws {Zotero.MCP.ToolError} If the arguments don't match the tool's inputSchema
	 */
	function checkArguments(tool, args) {
		let validator = _validators.get(tool.name);
		if (!validator) {
			let { JsonSchema } = ChromeUtils.importESModule('resource://gre/modules/JsonSchema.sys.mjs');
			// MCP's default JSON Schema version
			validator = new JsonSchema.Validator(tool.inputSchema, { draft: '2020-12', shortCircuit: false });
			_validators.set(tool.name, validator);
		}
		let { valid, errors } = validator.validate(args);
		if (!valid) {
			throw new Zotero.MCP.ToolError(
				'Invalid arguments: '
					+ errors.map(error => `${error.instanceLocation.replace(/^#\/?/, '/')}: ${error.error}`)
						.join('; ')
			);
		}
	}
	
	/**
	 * The command zotero-mcp-stdio runs to start this Zotero
	 */
	function getLaunchCommand() {
		let exe = Services.dirsvc.get('XREExeF', Ci.nsIFile).path;
		if (Zotero.isMac) {
			// Zotero.app/Contents/MacOS/zotero
			return { command: '/usr/bin/open', args: ['-a', PathUtils.parent(exe, 3)] };
		}
		if (Zotero.isLinux) {
			// The tarball's launcher script, which sets up the environment for zotero-bin
			let script = PathUtils.join(PathUtils.parent(exe), 'zotero');
			let file = Zotero.File.pathToFile(script);
			if (file.exists() && file.path != exe) {
				return { command: script, args: [] };
			}
		}
		return { command: exe, args: [] };
	}
	
	async function copyIfChanged(source, target, { executable }) {
		let contents = await IOUtils.read(source);
		if (await sameContents(target, contents)) {
			return;
		}
		// Write next to the target and move it into place, so an AI app starting the binary
		// never sees a partly written file
		let tmpPath = target + '.tmp';
		await IOUtils.write(tmpPath, contents);
		if (executable && !Zotero.isWin) {
			await IOUtils.setPermissions(tmpPath, 0o755);
		}
		await IOUtils.move(tmpPath, target);
		Zotero.debug(`MCP: Installed ${target}`);
	}
	
	async function writeIfChanged(target, text) {
		let contents = new TextEncoder().encode(text);
		if (await sameContents(target, contents)) {
			return;
		}
		await IOUtils.write(target, contents, { tmpPath: target + '.tmp' });
	}
	
	async function sameContents(path, contents) {
		let existing;
		try {
			existing = await IOUtils.read(path);
		}
		catch (e) {
			if (DOMException.isInstance(e) && e.name == 'NotFoundError') {
				return false;
			}
			throw e;
		}
		return existing.length == contents.length && existing.every((byte, i) => byte == contents[i]);
	}
};
