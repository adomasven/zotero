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

POST /mcp: MCP over HTTP, protocol 2026-07-28 (stateless, one JSON-RPC request per POST, JSON
responses only). zotero-mcp-stdio forwards AI apps' tool calls here; see mcp.js.

- Returns a plain-text 404 while MCP is disabled, which zotero-mcp-stdio reports as "turned
  off". A method it doesn't implement gets a 404 with a JSON-RPC error instead.
- The AI app is identified by the name in its MCP clientInfo (for example "claude-code"),
  which zotero-mcp-stdio forwards in each request's _meta. Apps name themselves and any local
  process can claim any name, so it identifies apps for permissions and display, not for
  security. Tool calls without one are refused.

*/

Zotero.Server.MCP = class {
	supportedMethods = ['POST'];
	
	supportedDataTypes = ['application/json'];
	
	static HEADER_MISMATCH = -32020;
	
	static UNSUPPORTED_PROTOCOL_VERSION = -32022;
	
	static result(id, result) {
		result = {
			resultType: 'complete',
			...result,
			_meta: {
				'io.modelcontextprotocol/serverInfo': { name: 'Zotero', version: Zotero.version },
				...result._meta,
			},
		};
		return [200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id, result })];
	}
	
	static error(status, id, code, message, data) {
		return [status, 'application/json', JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })];
	}
	
	/**
	 * Check the protocol version and the request metadata headers against the body, as
	 * 2026-07-28 requires
	 *
	 * @return {Array|null} [code, message, data] of the error, or null if they're valid
	 */
	static checkHeaders(headers, { id, method, params }) {
		let { HEADER_MISMATCH, UNSUPPORTED_PROTOCOL_VERSION, decodeHeader } = Zotero.Server.MCP;
		let version = headers['mcp-protocol-version'];
		if (!version) {
			return [HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing'];
		}
		if (version != Zotero.MCP.PROTOCOL_VERSION) {
			return [
				UNSUPPORTED_PROTOCOL_VERSION,
				'Unsupported protocol version',
				{ supported: [Zotero.MCP.PROTOCOL_VERSION], requested: version },
			];
		}
		let mirrors = [['Mcp-Method', headers['mcp-method'], method]];
		// Only requests carry the protocol version in _meta
		if (id !== undefined) {
			mirrors.push(['MCP-Protocol-Version', version, params?._meta?.['io.modelcontextprotocol/protocolVersion']]);
		}
		if (method == 'tools/call') {
			mirrors.push(['Mcp-Name', decodeHeader(headers['mcp-name']), params?.name]);
		}
		for (let [name, header, body] of mirrors) {
			if (header === undefined) {
				return [HEADER_MISMATCH, `Header mismatch: ${name} header is missing`];
			}
			if (header !== body) {
				return [
					HEADER_MISMATCH,
					`Header mismatch: ${name} header value '${header}' does not match body value '${body}'`,
				];
			}
		}
		return null;
	}
	
	/**
	 * A header value, decoded from the =?base64?…?= form that clients use for values that
	 * aren't plain ASCII
	 *
	 * @return {String|undefined|null} null if it isn't valid Base64 of UTF-8
	 */
	static decodeHeader(value) {
		let encoded = value?.match(/^=\?base64\?(.*)\?=$/)?.[1];
		if (encoded === undefined) {
			return value;
		}
		try {
			let bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
			return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		}
		catch {
			return null;
		}
	}
	
	async init({ headers, data }) {
		let { result: resultResponse, error: errorResponse } = Zotero.Server.MCP;
		if (!Zotero.Prefs.get('mcp.enabled')) {
			return [404, 'text/plain', 'MCP is not enabled\n'];
		}
		
		if (!data || typeof data != 'object' || Array.isArray(data)
				|| data.jsonrpc !== '2.0' || typeof data.method != 'string') {
			return errorResponse(400, null, -32600, 'Invalid JSON-RPC request');
		}
		let { id, method, params = {} } = data;
		let headerError = Zotero.Server.MCP.checkHeaders(headers, data);
		if (headerError) {
			return errorResponse(400, id ?? null, ...headerError);
		}
		// Notifications need no answer
		if (id === undefined) {
			return [202];
		}
		
		// The tool list changes only with Zotero, but it's cheap to fetch, so clients aren't
		// asked to cache it. It's the same for every user.
		let cacheable = { ttlMs: 0, cacheScope: 'public' };
		switch (method) {
			case 'server/discover':
				return resultResponse(id, {
					supportedVersions: [Zotero.MCP.PROTOCOL_VERSION],
					capabilities: { tools: {} },
					instructions: await Zotero.MCP.getInstructions(),
					...cacheable,
				});
			
			case 'tools/list':
				return resultResponse(id, { tools: await Zotero.MCP.getTools(), ...cacheable });
			
			case 'tools/call': {
				let { name, arguments: args = {} } = params;
				let tools = await Zotero.MCP.getTools();
				if (!tools.some(tool => tool.name === name)) {
					return errorResponse(200, id, -32602, `Unknown tool: ${name}`);
				}
				if (!args || typeof args != 'object' || Array.isArray(args)) {
					return errorResponse(200, id, -32602, 'arguments must be an object');
				}
				let clientInfo = params._meta?.['io.modelcontextprotocol/clientInfo'];
				let clientID = typeof clientInfo?.name == 'string' ? clientInfo.name.trim() : '';
				if (!clientID) {
					return resultResponse(id, {
						content: [{
							type: 'text',
							text: "This AI app didn't identify itself (MCP clientInfo has no name), so Zotero "
								+ "can't apply its permissions and refuses its requests.",
						}],
						isError: true,
					});
				}
				Zotero.debug(`MCP: ${clientID} called ${name}`);
				let result = await Zotero.MCP.callTool(name, args, { clientID });
				return resultResponse(id, result);
			}
			
			default:
				// A 404 with a JSON-RPC error, unlike the 404 of a Zotero without this endpoint
				return errorResponse(404, id, -32601, `Method not found: ${method}`);
		}
	}
};
Zotero.Server.Endpoints['/mcp'] = Zotero.Server.MCP;
