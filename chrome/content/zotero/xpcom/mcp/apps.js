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

The AI apps Zotero knows: how they identify themselves over MCP, how to tell they're installed,
and where they keep their MCP servers. Expect this list to need updates as apps change.

Installs are detected only by checking that files exist. Settings directories aren't enough,
since they outlive uninstalls. Apps launched from the Dock or Start menu, like Zotero, don't
get the shell's PATH, so command-line tools are also looked for where their installers and
package managers put them.

Install probes, any of which matching means the app is installed:

- { mac: 'Claude.app' }: an application bundle in /Applications or ~/Applications, optionally
  with a given bundle ID, for apps whose name another app also uses
- { win: 'Programs/cursor' }: a path under %LOCALAPPDATA%; { winPackage: 'Claude_' }: an MSIX
  package whose folder name starts with this
- { linux: 'cursor' }: a .desktop file of this name in the system, user, Flatpak or Snap
  application directories
- { exe: 'claude' }: a command-line tool in PATH or a common install location
- { editorExtension: 'saoudrizwan.claude-dev' }: a VS Code-style extension in VS Code, VS Code
  Insiders or Cursor
- { path: '/abs/path' }: any file or directory

*/

Zotero.MCP.Apps = new function () {
	// For apps Zotero doesn't know
	this.UNKNOWN_ICON = 'chrome://zotero/skin/20/universal/magic-wand.svg';
	
	/**
	 * Every known app, most popular first. Apps that don't identify themselves in their MCP
	 * clientInfo, e.g. Qoder ("mcphost") and CodeBuddy ("Copilot"), are left out: each would show
	 * up twice, as itself and as an unknown app.
	 *
	 * - clientNames: the names the app gives in its MCP clientInfo, which share its permissions
	 * - clientNamePrefixes: for apps whose name includes the server's name
	 * - icon: chrome URL of the app's icon
	 * - install: install probes (see above)
	 * - config: the file holding its MCP servers, or several, of which the first that exists
	 *   is used. Apps without one are only recognized by name; their servers have to be added
	 *   in the app.
	 * - format: 'json' (JSON or JSONC, servers under `key`, a key or a path of keys, each made by
	 *   `entry`, in a new file starting as `initial`) or 'codexToml'
	 */
	this.getAll = function () {
		let home = this.getHomeDir();
		let join = (...parts) => PathUtils.join(home, ...parts);
		let env = name => this.getEnv(name);
		// Per-user application settings (and data, on Linux) for desktop apps
		let appData, dataHome;
		if (Zotero.isMac) {
			appData = dataHome = join('Library', 'Application Support');
		}
		else if (Zotero.isWin) {
			appData = dataHome = Services.dirsvc.get('AppData', Ci.nsIFile).path;
		}
		else {
			appData = env('XDG_CONFIG_HOME') || join('.config');
			dataHome = env('XDG_DATA_HOME') || join('.local', 'share');
		}
		let stdio = command => ({ command, args: [] });
		
		let claudeHome = env('CLAUDE_CONFIG_DIR') || home;
		let codexHome = env('CODEX_HOME') || join('.codex');
		let copilotHome = env('COPILOT_HOME') || join('.copilot');
		let geminiHome = PathUtils.join(env('GEMINI_CLI_HOME') || home, '.gemini');
		let piHome = env('PI_CODING_AGENT_DIR') || join('.pi', 'agent');
		let opencodeHome = env('OPENCODE_CONFIG_DIR')
			|| PathUtils.join(env('XDG_CONFIG_HOME') || join('.config'), 'opencode');
		let zedHome = Zotero.isWin
			? PathUtils.join(appData, 'Zed')
			: Zotero.isMac
				? join('.config', 'zed')
				: PathUtils.join(env('FLATPAK_XDG_CONFIG_HOME') || appData, 'zed');
		
		let apps = [
			{
				id: 'claude-desktop',
				clientNames: ['claude-ai'],
				name: 'Claude',
				install: [
					{ mac: 'Claude.app' },
					{ win: 'AnthropicClaude' },
					{ winPackage: 'Claude_' },
					{ winPackage: 'AnthropicPBC.Claude_' },
					{ path: '/usr/lib/claude-desktop' },
					{ path: '/usr/bin/claude-desktop' },
					{ linux: 'claude-desktop' },
				],
				config: PathUtils.join(getClaudeDesktopDir(appData), 'claude_desktop_config.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				// The ChatGPT desktop app, Codex app, CLI and IDE extension share this
				// configuration, and all send the same name
				id: 'codex',
				clientNames: ['codex-mcp-client'],
				name: 'ChatGPT and Codex',
				install: [
					// The classic ChatGPT app, also ChatGPT.app, doesn't read Codex's configuration
					{ mac: 'ChatGPT.app', bundleID: 'com.openai.codex' },
					{ mac: 'Codex.app', bundleID: 'com.openai.codex' },
					{ winPackage: 'OpenAI.Codex_' },
					{ win: 'Programs/OpenAI/Codex' },
					{ path: '/usr/bin/chatgpt' },
					{ exe: 'codex' },
					{ editorExtension: 'openai.chatgpt' },
				],
				config: PathUtils.join(codexHome, 'config.toml'),
				format: 'codexToml',
			},
			{
				id: 'claude-code',
				clientNames: ['claude-code'],
				name: 'Claude Code',
				install: [
					{ exe: 'claude' },
					{ path: join('.claude', 'local', 'claude') },
					{ editorExtension: 'anthropic.claude-code' },
				],
				config: PathUtils.join(claudeHome, '.claude.json'),
				format: 'json',
				key: 'mcpServers',
				entry: command => ({ type: 'stdio', ...stdio(command) }),
			},
			{
				id: 'cursor',
				clientNames: ['cursor-vscode', 'Cursor'],
				name: 'Cursor',
				install: [
					{ mac: 'Cursor.app' },
					{ win: 'Programs/cursor' },
					{ path: '/usr/share/cursor' },
					{ path: '/opt/cursor' },
					{ linux: 'cursor' },
					{ exe: 'cursor-agent' },
				],
				config: join('.cursor', 'mcp.json'),
				format: 'json',
				key: 'mcpServers',
				entry: command => ({ type: 'stdio', ...stdio(command) }),
			},
			{
				// VS Code's default for user servers is now Copilot's global configuration, which
				// the Copilot CLI also reads. VS Code identifies itself, not Copilot.
				id: 'vscode',
				clientNames: ['Visual Studio Code', 'Visual Studio Code - Insiders', 'github-copilot-developer'],
				name: 'VS Code and Copilot CLI',
				install: [
					{ mac: 'Visual Studio Code.app' },
					{ mac: 'Visual Studio Code - Insiders.app' },
					{ win: 'Programs/Microsoft VS Code' },
					{ win: 'Programs/Microsoft VS Code Insiders' },
					{ path: 'C:\\Program Files\\Microsoft VS Code' },
					{ path: '/usr/share/code' },
					{ path: '/usr/share/code-insiders' },
					{ path: '/snap/bin/code' },
					{ linux: 'code' },
					{ linux: 'code-insiders' },
					{ linux: 'com.visualstudio.code' },
					{ exe: 'copilot' },
				],
				config: PathUtils.join(copilotHome, 'mcp-config.json'),
				format: 'json',
				key: 'mcpServers',
				entry: command => ({ type: 'stdio', ...stdio(command), tools: ['*'] }),
			},
			{
				id: 'gemini-cli',
				clientNames: ['gemini-cli-mcp-client'],
				name: 'Gemini CLI',
				install: [{ exe: 'gemini' }],
				config: PathUtils.join(geminiHome, 'settings.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'antigravity',
				clientNames: ['antigravity-client'],
				name: 'Antigravity',
				install: [
					{ mac: 'Antigravity.app' },
					{ mac: 'Antigravity IDE.app' },
					{ win: 'Programs/antigravity' },
					{ win: 'Programs/Antigravity IDE' },
					{ path: join('.local', 'share', 'antigravity-ide') },
					{ linux: 'antigravity' },
					{ exe: 'agy' },
				],
				config: join('.gemini', 'config', 'mcp_config.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'cline',
				clientNames: ['Cline', '@cline/core'],
				name: 'Cline',
				install: [
					{ editorExtension: 'saoudrizwan.claude-dev' },
					{ exe: 'cline' },
				],
				config: join('.cline', 'data', 'settings', 'cline_mcp_settings.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'kiro',
				clientNames: ['kiro', 'Q DEV CLI'],
				name: 'Kiro',
				install: [
					{ mac: 'Kiro.app' },
					{ mac: 'Kiro CLI.app' },
					{ win: 'Programs/Kiro' },
					{ path: '/usr/share/kiro' },
					{ linux: 'kiro' },
					{ exe: 'kiro-cli' },
				],
				config: join('.kiro', 'settings', 'mcp.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'zed',
				clientNames: ['Zed'],
				name: 'Zed',
				install: [
					{ mac: 'Zed.app' },
					{ mac: 'Zed Preview.app' },
					{ win: 'Programs/Zed' },
					{ linux: 'dev.zed.Zed' },
					{ linux: 'dev.zed.Zed-Preview' },
					{ path: join('.local', 'zed.app') },
					{ path: join('.local', 'zed-preview.app') },
				],
				config: PathUtils.join(zedHome, 'settings.json'),
				format: 'json',
				key: 'context_servers',
				entry: stdio,
			},
			{
				id: 'junie',
				clientNames: ['junie-client'],
				name: 'Junie',
				install: [{ exe: 'junie' }],
				config: join('.junie', 'mcp', 'mcp.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'warp',
				clientNames: ['dev.warp.Warp-Stable', 'dev.warp.Warp', 'warp'],
				name: 'Warp',
				install: [
					{ mac: 'Warp.app' },
					{ win: 'Programs/Warp' },
					{ path: '/opt/warpdotdev' },
					{ path: '/usr/bin/warp-terminal' },
					{ linux: 'dev.warp.Warp' },
				],
				config: join('.warp', '.mcp.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'opencode',
				clientNames: ['opencode'],
				name: 'opencode',
				install: [
					{ exe: 'opencode' },
					{ path: join('.opencode', 'bin') },
				],
				config: [
					PathUtils.join(opencodeHome, 'opencode.json'),
					PathUtils.join(opencodeHome, 'opencode.jsonc'),
				],
				format: 'json',
				key: 'mcp',
				entry: command => ({ type: 'local', command: [command] }),
			},
			{
				id: 'amp',
				clientNames: ['amp-mcp-client'],
				name: 'Amp',
				install: [
					{ exe: 'amp' },
					{ path: join('.amp', 'bin') },
					{ editorExtension: 'sourcegraph.amp' },
				],
				config: [
					join('.config', 'amp', 'settings.json'),
					join('.config', 'amp', 'settings.jsonc'),
				],
				format: 'json',
				// A single key containing a dot
				key: 'amp.mcpServers',
				entry: stdio,
			},
			{
				id: 'pi',
				clientNames: ['pi'],
				name: 'Pi',
				install: [
					{ exe: 'pi' },
					// pi.dev's installer
					{ path: PathUtils.join(piHome, 'install') },
				],
				config: PathUtils.join(piHome, 'mcp.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'jan',
				clientNames: ['Jan', 'Jan CLI Client'],
				name: 'Jan',
				install: [
					{ mac: 'Jan.app' },
					{ win: 'Jan/Jan-Desktop.exe' },
					{ path: '/usr/bin/Jan-Desktop' },
					{ linux: 'Jan' },
				],
				config: PathUtils.join(dataHome, 'Jan', 'data', 'mcp_config.json'),
				format: 'json',
				key: 'mcpServers',
				entry: command => ({ type: 'stdio', ...stdio(command), env: {}, active: true }),
			},
			{
				// Its settings are JSON5. Files using JSON5 syntax beyond comments and trailing
				// commas can't be read, so Zotero doesn't change them.
				id: 'openclaw',
				clientNames: ['openclaw-bundle-mcp', 'openclaw-node-host'],
				name: 'OpenClaw',
				install: [
					{ mac: 'OpenClaw.app' },
					{ path: join('.openclaw', 'bin') },
					{ linux: 'OpenClaw' },
					{ exe: 'openclaw' },
				],
				config: env('OPENCLAW_CONFIG_PATH')
					|| PathUtils.join(env('OPENCLAW_STATE_DIR') || join('.openclaw'), 'openclaw.json'),
				format: 'json',
				key: ['mcp', 'servers'],
				entry: stdio,
			},
			{
				// Meta's coding CLI. Its MCP client names itself by its internal name, "tbh" (from the
				// Muse Code 1.4.20 binary, as a live run needs a Meta API key).
				id: 'muse',
				clientNames: ['tbh'],
				name: 'Muse Code',
				install: [{ exe: 'muse' }, { win: 'Programs/muse' }],
				config: PathUtils.join(env('XDG_CONFIG_HOME') || join('.config'), 'muse', 'settings.json'),
				format: 'json',
				key: 'mcpServers',
				// A new settings file needs its version
				initial: { schema_version: 1 }, // eslint-disable-line camelcase
				// Servers may be required by default, which would stop Muse when Zotero isn't open
				entry: command => ({ ...stdio(command), required: false }),
			},
			// Popular in China
			{
				// Trae and Trae CN. "Trae" captured from Trae 3.6.13; "Trae CN" unverified. Trae
				// doesn't allow spaces in the command.
				id: 'trae',
				clientNames: ['Trae', 'Trae CN'],
				name: 'Trae',
				install: [
					{ mac: 'Trae.app' },
					{ mac: 'Trae CN.app' },
					{ win: 'Programs/Trae' },
					{ win: 'Programs/Trae CN' },
					{ linux: 'trae' },
				],
				config: [
					PathUtils.join(appData, 'Trae', 'User', 'mcp.json'),
					PathUtils.join(appData, 'Trae CN', 'User', 'mcp.json'),
				],
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'qoder-cli',
				clientNames: ['qodercli', 'qoderclicn'],
				name: 'Qoder CLI',
				install: [{ exe: 'qodercli' }, { exe: 'qoder-cn' }],
				config: env('QODER_CONFIG_DIR')
					? PathUtils.join(env('QODER_CONFIG_DIR'), 'settings.json')
					: [join('.qoder', 'settings.json'), join('.qoder-cn', 'settings.json')],
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'kimi-code',
				clientNames: ['kimi-code'],
				name: 'Kimi Code',
				install: [
					{ path: join('.kimi-code', 'bin') },
					{ exe: 'kimi' },
					{ editorExtension: 'moonshot-ai.kimi-code' },
				],
				config: PathUtils.join(env('KIMI_CODE_HOME') || join('.kimi-code'), 'mcp.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			{
				id: 'qwen-code',
				clientNames: ['qwen-cli-mcp-client-zotero'],
				clientNamePrefixes: ['qwen-cli-mcp-client-'],
				name: 'Qwen Code',
				install: [{ exe: 'qwen' }],
				config: PathUtils.join(env('QWEN_HOME') || join('.qwen'), 'settings.json'),
				format: 'json',
				key: 'mcpServers',
				entry: stdio,
			},
			// Recognized by name only: their configuration is YAML
			{ id: 'hermes', clientNames: ['hermes-agent'], name: 'Hermes Agent' },
			{ id: 'deepseek-harness', clientNames: ['dsh-mcp-client'], name: 'DeepSeek Harness' },
			{ id: 'goose', clientNames: ['goose-desktop', 'goose-cli', 'goose-app'], name: 'Goose' },
		];
		for (let app of apps) {
			app.icon = `chrome://zotero/skin/mcp-apps/${app.id}.png`;
			app.install ??= [];
		}
		return apps;
	};
	
	/**
	 * @param {String} clientID - A name from an MCP clientInfo
	 * @return {Object|null} The known app with that name
	 */
	this.getForClient = function (clientID) {
		return this.getAll().find(app => this.matchesClient(app, clientID)) || null;
	};
	
	/**
	 * @param {String} clientID - A name from an MCP clientInfo
	 * @return {Boolean}
	 */
	this.matchesClient = function (app, clientID) {
		return app.clientNames.includes(clientID)
			|| !!app.clientNamePrefixes?.some(prefix => clientID.startsWith(prefix));
	};
	
	/**
	 * @return {String} The app's product name if Zotero knows it, otherwise the name it gave
	 */
	this.getDisplayName = function (clientID) {
		return this.getForClient(clientID)?.name ?? clientID;
	};
	
	/**
	 * @return {Promise<Boolean>}
	 */
	this.isInstalled = async function (app) {
		for (let probe of app.install) {
			if (await this._matches(probe)) {
				return true;
			}
		}
		return false;
	};
	
	// Overridden in tests
	this.getHomeDir = function () {
		return Services.dirsvc.get('Home', Ci.nsIFile).path;
	};
	
	// Overridden in tests
	this.getEnv = function (name) {
		return Services.env.get(name);
	};
	
	this._matches = async function (probe) {
		let home = this.getHomeDir();
		if (probe.path) {
			// Paths for other platforms aren't absolute here
			return PathUtils.isAbsolute(probe.path) && IOUtils.exists(probe.path);
		}
		if (probe.mac) {
			if (!Zotero.isMac) return false;
			for (let dir of ['/Applications', PathUtils.join(home, 'Applications')]) {
				let bundle = PathUtils.join(dir, probe.mac);
				if (!await IOUtils.exists(bundle)) continue;
				if (!probe.bundleID || await getBundleID(bundle) == probe.bundleID) {
					return true;
				}
			}
			return false;
		}
		if (probe.win) {
			return Zotero.isWin && IOUtils.exists(PathUtils.join(getLocalAppData(), ...probe.win.split('/')));
		}
		if (probe.winPackage) {
			return Zotero.isWin && hasChildStartingWith(PathUtils.join(getLocalAppData(), 'Packages'), probe.winPackage);
		}
		if (probe.linux) {
			if (Zotero.isMac || Zotero.isWin) return false;
			let dataHome = this.getEnv('XDG_DATA_HOME') || PathUtils.join(home, '.local', 'share');
			let dataDirs = (this.getEnv('XDG_DATA_DIRS') || '/usr/local/share:/usr/share').split(':');
			let dirs = [
				dataHome,
				...dataDirs,
				PathUtils.join(dataHome, 'flatpak', 'exports', 'share'),
				'/var/lib/flatpak/exports/share',
				'/var/lib/snapd/desktop',
			].filter(dir => dir.startsWith('/'));
			return anyExists(dirs.map(dir => PathUtils.join(dir, 'applications', probe.linux + '.desktop')));
		}
		if (probe.exe) {
			let names = Zotero.isWin
				? ['.exe', '.cmd', '.bat', '.ps1'].map(ext => probe.exe + ext)
				: [probe.exe];
			for (let dir of await this.getBinDirs()) {
				if (await anyExists(names.map(name => PathUtils.join(dir, name)))) {
					return true;
				}
			}
			return false;
		}
		if (probe.editorExtension) {
			for (let dir of ['.vscode', '.vscode-insiders', '.cursor']) {
				if (await hasChildStartingWith(PathUtils.join(home, dir, 'extensions'), probe.editorExtension + '-')) {
					return true;
				}
			}
			return false;
		}
		throw new Error(`Unknown install probe ${JSON.stringify(probe)}`);
	};
	
	/**
	 * Where command-line tools are installed: PATH, plus where installers and package managers
	 * put them, since PATH may not include those for apps not started from a shell
	 *
	 * @return {Promise<String[]>}
	 */
	this.getBinDirs = async function () {
		let home = this.getHomeDir();
		let join = (...parts) => PathUtils.join(home, ...parts);
		let path = (this.getEnv('PATH') || '').split(Zotero.isWin ? ';' : ':');
		let dirs = [
			...path,
			join('.local', 'bin'),
			join('bin'),
			join('.npm-global', 'bin'),
			join('.bun', 'bin'),
			join('.volta', 'bin'),
			join('.deno', 'bin'),
			join('.cargo', 'bin'),
			join('.yarn', 'bin'),
			join('.opencode', 'bin'),
			join('.amp', 'bin'),
			join('.claude', 'local'),
			join('.openclaw', 'bin'),
			join('.kimi-code', 'bin'),
		];
		if (Zotero.isWin) {
			let appData = Services.dirsvc.get('AppData', Ci.nsIFile).path;
			let localAppData = getLocalAppData();
			dirs.push(
				PathUtils.join(appData, 'npm'),
				PathUtils.join(localAppData, 'pnpm'),
				PathUtils.join(localAppData, 'Volta', 'bin'),
				PathUtils.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
				PathUtils.join(localAppData, 'Programs', 'muse'),
				PathUtils.join(localAppData, 'agy', 'bin'),
				PathUtils.join(localAppData, 'qwen-code', 'bin'),
				PathUtils.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
				join('scoop', 'shims'),
			);
		}
		else {
			dirs.push(
				'/usr/local/bin',
				'/usr/bin',
				'/opt/homebrew/bin',
				'/home/linuxbrew/.linuxbrew/bin',
				'/opt/local/bin',
				'/snap/bin',
				Zotero.isMac
					? join('Library', 'pnpm')
					: join('.local', 'share', 'pnpm'),
			);
			// Each installed Node version has its own global bin directory
			for (let versions of [
				join('.nvm', 'versions', 'node'),
				join('.local', 'share', 'fnm', 'node-versions'),
				join('Library', 'Application Support', 'fnm', 'node-versions'),
			]) {
				for (let version of await getChildren(versions)) {
					dirs.push(PathUtils.join(version, 'bin'), PathUtils.join(version, 'installation', 'bin'));
				}
			}
		}
		return [...new Set(dirs.filter(dir => dir && PathUtils.isAbsolute(dir)))];
	};
	
	/**
	 * Claude's settings directory. On Windows, Claude is usually installed as an MSIX package,
	 * whose settings are in the package's own folder.
	 */
	function getClaudeDesktopDir(appData) {
		let dir = PathUtils.join(appData, 'Claude');
		if (!Zotero.isWin) {
			return dir;
		}
		try {
			let packages = Services.dirsvc.get('LocalAppData', Ci.nsIFile);
			packages.append('Packages');
			if (packages.exists()) {
				for (let entry of packages.directoryEntries) {
					if (entry.leafName.startsWith('Claude_')) {
						return PathUtils.join(entry.path, 'LocalCache', 'Roaming', 'Claude');
					}
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		return dir;
	}
	
	/**
	 * @return {Promise<String|null>} CFBundleIdentifier from the bundle's Info.plist, if it's XML
	 */
	async function getBundleID(bundle) {
		try {
			let plist = await IOUtils.readUTF8(PathUtils.join(bundle, 'Contents', 'Info.plist'));
			return plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
		}
		catch {
			return null;
		}
	}
	
	function getLocalAppData() {
		return Services.dirsvc.get('LocalAppData', Ci.nsIFile).path;
	}
	
	async function anyExists(paths) {
		for (let path of paths) {
			if (await IOUtils.exists(path)) {
				return true;
			}
		}
		return false;
	}
	
	async function getChildren(dir) {
		try {
			return await IOUtils.getChildren(dir);
		}
		catch {
			return [];
		}
	}
	
	async function hasChildStartingWith(dir, prefix) {
		return (await getChildren(dir)).some(path => PathUtils.filename(path).startsWith(prefix));
	}
};
