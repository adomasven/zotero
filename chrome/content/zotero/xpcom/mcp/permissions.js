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

Per-app permissions for MCP tools.

Reading and UI actions need no permission. Tools that change something declare the permission
they need in tools.json, and Zotero.MCP.callTool() calls require() before running them:

- EDIT_LIBRARY: add or change items, collections, tags and notes in one library
- DELETE: move items or collections in one library to the trash
- EDIT_SETTINGS: change Zotero settings
- INSTALL_STYLES: install citation styles from the Zotero Style Repository

Grants are stored per app, permission and library, in the mcp.clients pref as JSON:

  { apps: { <app ID>: <app> }, clients: { <name>: <app> } }
  <app>: { lastSeen, grants: { <permission>[:<libraryID>]: { until } } }

Apps are identified by their MCP clientInfo name. Apps in Zotero.MCP.Apps are stored under
their ID, so all the names an app gives share its grants; other apps under their name.

A permission with no grant is asked for: a dialog offers Allow (this time only), Always Allow
(Allow for 1 Hour for DELETE) and Deny. The dialog closes, as no answer, when MCP is turned
off, or after DIALOG_TIMEOUT if nobody answers -- a little less than zotero-mcp-stdio waits for a
call, so an answer doesn't come after the AI app has given up.

*/

Zotero.MCP.Permissions = new function () {
	const PREF = 'mcp.clients';
	
	this.EDIT_LIBRARY = 'editLibrary';
	this.DELETE = 'delete';
	this.EDIT_SETTINGS = 'editSettings';
	this.INSTALL_STYLES = 'installStyles';
	
	// How long DELETE is allowed for at a time
	this.TEMPORARY_GRANT = 60 * 60 * 1000;
	
	// Shorter than zotero-mcp-stdio's default call timeout (50 s), so Zotero's answer that
	// nothing was changed reaches the AI app before the bridge gives up on the call.
	// Overridden in tests.
	this.DIALOG_TIMEOUT = 45 * 1000;
	
	// Open dialogs, keyed by grant, so parallel calls needing the same grant share one
	let _pending = new Map();
	
	/**
	 * Make sure the app may do something, asking the user if needed
	 *
	 * @param {String} clientID - The AI app's name
	 * @param {String} permission - One of the permissions above
	 * @param {Integer} [libraryID] - Required for EDIT_LIBRARY and DELETE
	 * @param {AbortSignal} [signal] - Aborted when MCP is turned off, which closes the dialog
	 * @throws {Zotero.MCP.ToolError} If the user denies it or doesn't answer, or MCP is turned
	 *     off
	 */
	this.require = async function (clientID, permission, libraryID = null, signal = null) {
		let target = getTarget(permission, libraryID);
		if (this.isGranted(clientID, permission, libraryID)) {
			return;
		}
		let key = JSON.stringify([getOwner(clientID), target]);
		let answer = _pending.get(key);
		if (!answer) {
			answer = this._ask(clientID, permission, libraryID, signal);
			_pending.set(key, answer);
			answer.finally(() => _pending.delete(key));
		}
		answer = await answer;
		if (signal?.aborted) {
			throw new Zotero.MCP.ToolError('AI app access was turned off in Zotero, so nothing was changed.');
		}
		let description = describe(permission, libraryID);
		switch (answer) {
			case 'allow':
				return;
			
			case 'extra': {
				let until = permission == this.DELETE ? Date.now() + this.TEMPORARY_GRANT : null;
				this.grant(clientID, permission, libraryID, until);
				return;
			}
			
			case 'deny':
				throw new Zotero.MCP.ToolError(
					`The user denied this app permission to ${description}. Don't retry without `
						+ "asking the user. If they want to allow it, they can choose Allow when Zotero "
						+ "asks again."
				);
			
			default:
				throw new Zotero.MCP.ToolError(
					`Zotero asked the user for permission to ${description}, but they didn't answer, `
						+ "so nothing was changed. Ask the user before trying again."
				);
		}
	};
	
	/**
	 * @return {Boolean}
	 */
	this.isGranted = function (clientID, permission, libraryID = null) {
		let grant = getEntry(load(), clientID)?.grants[getTarget(permission, libraryID)];
		return !!grant && (grant.until === null || grant.until > Date.now());
	};
	
	/**
	 * @param {Number|null} until - Expiry timestamp, or null for no expiry
	 */
	this.grant = function (clientID, permission, libraryID, until = null) {
		let data = load();
		getEntry(data, clientID, true).grants[getTarget(permission, libraryID)] = { until };
		save(data);
	};
	
	this.revoke = function (clientID, permission, libraryID = null) {
		let data = load();
		let entry = getEntry(data, clientID);
		if (entry) {
			delete entry.grants[getTarget(permission, libraryID)];
			save(data);
		}
	};
	
	/**
	 * Record that an app has connected, so it can be listed in settings
	 */
	this.recordClient = function (clientID) {
		let data = load();
		let isNew = !getEntry(data, clientID);
		let client = getEntry(data, clientID, true);
		let now = Date.now();
		// Don't rewrite prefs on every call
		if (isNew || now - client.lastSeen > 60 * 60 * 1000) {
			client.lastSeen = now;
			save(data);
		}
	};
	
	/**
	 * @return {Object[]} Apps that have used Zotero, as { clientID, app, lastSeen }, most
	 *     recent first. For apps in Zotero.MCP.Apps, app is the app and clientID one of its
	 *     names; for others, app is null.
	 */
	this.getClients = function () {
		let data = load();
		let apps = Zotero.MCP.Apps.getAll();
		return [
			...Object.entries(data.apps).flatMap(([id, { lastSeen }]) => {
				let app = apps.find(app => app.id == id);
				return app ? [{ clientID: app.clientNames[0], app, lastSeen }] : [];
			}),
			...Object.entries(data.clients).map(([clientID, { lastSeen }]) => ({ clientID, app: null, lastSeen })),
		].sort((a, b) => b.lastSeen - a.lastSeen);
	};
	
	/**
	 * Remove an app and all its grants. It's listed again if it calls again.
	 */
	this.forgetClient = function (clientID) {
		let data = load();
		let [group, id] = getOwner(clientID);
		delete data[group][id];
		save(data);
	};
	
	/**
	 * @return {Object[]} The app's unexpired grants, as
	 *     { permission, libraryID, until }
	 */
	this.getGrants = function (clientID) {
		let grants = getEntry(load(), clientID)?.grants || {};
		return Object.entries(grants)
			.filter(([, { until }]) => until === null || until > Date.now())
			.map(([target, { until }]) => {
				let [permission, libraryID] = target.split(':');
				return {
					permission,
					libraryID: libraryID ? parseInt(libraryID) : null,
					until: until === null ? null : new Date(until).toISOString(),
				};
			});
	};
	
	/**
	 * Show the consent dialog
	 *
	 * @param {AbortSignal} [signal] - Closes the dialog, as no answer
	 * @return {Promise<String|null>} 'allow', 'extra' (Always Allow, or Allow for 1 Hour for
	 *     DELETE), 'deny', or null if nobody answered in time or the signal was aborted
	 */
	this._ask = function (clientID, permission, libraryID, signal = null) {
		let { promise, resolve } = Promise.withResolvers();
		let app = Zotero.MCP.Apps.getForClient(clientID);
		let { PromptUtils } = ChromeUtils.importESModule('resource://gre/modules/PromptUtils.sys.mjs');
		// Firefox's prompt dialog, with the arguments Services.prompt.confirmEx() gives it.
		// confirmEx() opens it as a modal window and waits for it, which would block Zotero and
		// every other call; opened directly, it doesn't, and can be closed if nobody answers.
		// Escape and closing the window choose button 1, so that's Deny.
		let args = PromptUtils.objectToPropBag({
			promptType: 'confirmEx',
			title: Zotero.ftl.formatValueSync('mcp-consent-title'),
			text: Zotero.ftl.formatValueSync('mcp-consent-text', {
				app: Zotero.MCP.Apps.getDisplayName(clientID),
				action: describe(permission, libraryID),
			}),
			button0Label: Zotero.ftl.formatValueSync('general-allow'),
			button1Label: Zotero.ftl.formatValueSync('general-deny'),
			button2Label: Zotero.ftl.formatValueSync(
				permission == this.DELETE ? 'mcp-consent-allow-hour' : 'general-always-allow'
			),
			defaultButtonNum: 0,
			buttonNumClicked: 1,
			ok: false,
		});
		let win = Services.ww.openWindow(
			null,
			'chrome://global/content/commonDialog.xhtml',
			'',
			'chrome,dialog,centerscreen,alwaysRaised,resizable=no',
			args
		);
		win.addEventListener('load', () => {
			if (app) {
				// In place of the question mark
				win.document.getElementById('infoIcon').setAttribute('src', app.icon);
			}
			// Added after the dialog's own unload listener, which records the answer
			win.addEventListener('unload', () => {
				resolve(['allow', 'deny', 'extra'][args.getProperty('buttonNumClicked')] ?? 'deny');
			});
		}, { once: true });
		let close = () => {
			// Resolve first, so closing doesn't count as Deny
			resolve(null);
			win.close();
		};
		let timer = setTimeout(close, this.DIALOG_TIMEOUT);
		signal?.addEventListener('abort', close);
		promise.finally(() => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', close);
		});
		return promise;
	};
	
	function getTarget(permission, libraryID) {
		let { EDIT_SETTINGS, INSTALL_STYLES } = Zotero.MCP.Permissions;
		// Not per library
		if (permission == EDIT_SETTINGS || permission == INSTALL_STYLES) {
			return permission;
		}
		if (permission != Zotero.MCP.Permissions.EDIT_LIBRARY
				&& permission != Zotero.MCP.Permissions.DELETE) {
			throw new Error(`Unknown MCP permission ${permission}`);
		}
		if (!Number.isInteger(libraryID)) {
			throw new Error(`${permission} needs a library`);
		}
		return `${permission}:${libraryID}`;
	}
	
	/**
	 * What the permission allows, to complete "wants to …" and "permission to …"
	 */
	function describe(permission, libraryID) {
		if (permission == Zotero.MCP.Permissions.EDIT_SETTINGS) {
			return Zotero.ftl.formatValueSync('mcp-permission-edit-settings');
		}
		if (permission == Zotero.MCP.Permissions.INSTALL_STYLES) {
			return Zotero.ftl.formatValueSync('mcp-permission-install-styles');
		}
		let library = Zotero.Libraries.get(libraryID).name;
		return Zotero.ftl.formatValueSync(
			permission == Zotero.MCP.Permissions.DELETE
				? 'mcp-permission-delete'
				: 'mcp-permission-edit-library',
			{ library }
		);
	}
	
	/**
	 * @return {String[]} Where the app's grants are stored: ['apps', <app ID>] for apps in
	 *     Zotero.MCP.Apps, else ['clients', <name>]
	 */
	function getOwner(clientID) {
		let app = Zotero.MCP.Apps.getForClient(clientID);
		return app ? ['apps', app.id] : ['clients', clientID];
	}
	
	/**
	 * @param {Boolean} [create] - Add the app if it's not there
	 * @return {Object|undefined} The app's { lastSeen, grants }
	 */
	function getEntry(data, clientID, create = false) {
		let [group, id] = getOwner(clientID);
		if (!data[group][id] && create) {
			data[group][id] = { lastSeen: Date.now(), grants: {} };
		}
		return data[group][id];
	}
	
	function load() {
		let data = {};
		try {
			let parsed = JSON.parse(Zotero.Prefs.get(PREF));
			if (parsed && typeof parsed == 'object' && !Array.isArray(parsed)) {
				data = parsed;
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		data.apps ??= {};
		data.clients ??= {};
		return data;
	}
	
	function save(data) {
		Zotero.Prefs.set(PREF, JSON.stringify(data));
	}
	
	/**
	 * Forget all apps and grants. For tests.
	 */
	this._reset = function () {
		Zotero.Prefs.clear(PREF);
	};
};
