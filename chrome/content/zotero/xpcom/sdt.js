/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2026 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     http://digitalscholar.org/

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

const SDT_CACHE_FILE_NAME = '.zotero-sdt-cache';
const DOCUMENT_WORKER_METADATA_URL = 'resource://zotero/document-worker/metadata.json';

Zotero.SDT = new function () {
	// Per-item in-flight generation, so that concurrent getPack() calls share
	// one extraction and two generations can never race on the same cache file
	let _generating = new Map();
	let _sourceHashCache = new Map();
	// Source hash of the last password-required failure per item, so that a
	// password-protected file isn't re-extracted until the file changes
	let _passwordFailures = new Map();
	let _module = null;
	let _moduleErrorLogged = false;
	let _documentWorkerMetadata = null;
	let _documentWorkerMetadataErrorLogged = false;

	// Load the bundled SDT modules (pack reader and chunker) lazily, so that a
	// missing or broken resource degrades to an 'unavailable' result instead
	// of breaking Zotero startup. Load failures aren't cached, so a load is
	// retried on the next call (require() itself caches successful loads)
	function _getModule() {
		if (!_module) {
			try {
				_module = {
					...require('resource://zotero/document-worker/structured-document-text.js'),
					...require('resource://zotero/document-worker/structured-document-text-chunker.js')
				};
			}
			catch (e) {
				if (!_moduleErrorLogged) {
					_moduleErrorLogged = true;
					Zotero.logError(e);
				}
				return null;
			}
		}
		return _module;
	}

	/**
	 * Get the structured document text pack for a PDF, EPUB, or snapshot
	 * attachment, generating and caching it if necessary. The returned bytes
	 * are owned by the caller -- a later regeneration can't affect them.
	 *
	 * If the cached pack was produced by an older (but still readable)
	 * processor version, it's returned as is and a regeneration is started in
	 * the background, so that processor bumps don't block consumers.
	 *
	 * @param {Integer} itemID
	 * @param {Object} [options]
	 * @param {Boolean} [options.isPriority] - Put a needed extraction at the
	 *     front of the worker queue (for user-initiated requests)
	 * @param {Boolean} [options.cachedOnly] - Return 'not-cached' rather than
	 *     extracting the document when no pack is cached
	 * @param {Function} [options.onProgress] - Called with SDT generation
	 *     progress from 0 to 100 when generation is needed
	 * @returns {Promise<Object>} { ok: true, bytes: ArrayBuffer, packVersion,
	 *     schemaMajorVersion }, or { ok: false, reason: 'unavailable' |
	 *     'password-required' | 'not-cached' | 'failed' }
	 */
	this.getPack = async function (itemID, options = {}) {
		try {
			if (!_getModule() || !(await _getDocumentWorkerMetadata())) {
				return { ok: false, reason: 'unavailable' };
			}
			let context = await _getAttachmentContext(itemID);
			if (!context.ok) {
				return { ok: false, reason: context.reason };
			}
			let cache = await _readValidCache(context, { allowStaleProcessorVersion: true });
			if (cache.ok) {
				if (cache.staleProcessorVersion) {
					_generate(context, {}).catch(e => Zotero.logError(e));
				}
				return _makeResult(cache);
			}
			// Extraction takes seconds, which some callers won't wait for
			if (options.cachedOnly) {
				return { ok: false, reason: 'not-cached' };
			}
			return await _generate(context, options);
		}
		catch (e) {
			Zotero.logError(e);
			return { ok: false, reason: 'failed' };
		}
	};

	/**
	 * Ensure that a current pack is cached for an attachment, generating or
	 * regenerating it if necessary, without returning it. For warming up the
	 * cache (e.g., at import time), so that later getPack() calls are hits.
	 *
	 * Unlike getPack(), which returns a stale-processor pack immediately and
	 * regenerates in the background, this resolves only once the cache is
	 * fully current.
	 *
	 * @param {Integer} itemID
	 * @param {Object} [options] - See getPack()
	 * @returns {Promise<Boolean>} - Whether a current pack is cached
	 */
	this.ensure = async function (itemID, options = {}) {
		try {
			if (!_getModule() || !(await _getDocumentWorkerMetadata())) {
				return false;
			}
			let context = await _getAttachmentContext(itemID);
			if (!context.ok) {
				return false;
			}
			let cache = await _readValidCache(context, {});
			if (cache.ok) {
				return true;
			}
			let result = await _generate(context, options);
			return result.ok;
		}
		catch (e) {
			Zotero.logError(e);
			return false;
		}
	};

	/**
	 * Get a parsed pack reader for in-process consumers
	 *
	 * @param {Integer} itemID
	 * @param {Object} [options] - See getPack()
	 * @returns {Promise<Object|null>}
	 */
	this.getReader = async function (itemID, options = {}) {
		let result = await this.getPack(itemID, options);
		if (!result.ok) {
			return null;
		}
		return _openPack(new Uint8Array(result.bytes));
	};

	/**
	 * Whether the cached pack was made by the current extraction: the same
	 * pack format, schema major version and processor. Reads only the pack's
	 * header and metadata, not the attachment's file.
	 *
	 * @param {Integer} itemID
	 * @returns {Promise<Boolean>} - False also when there's no readable pack
	 */
	this.isCurrent = async function (itemID) {
		let item = await Zotero.Items.getAsync(itemID, { noCache: true });
		let processorType = item && item.isAttachment() && _getProcessorType(item);
		let expected = processorType && _getModule() && await _getDocumentWorkerMetadata();
		if (!expected) {
			return false;
		}
		let path = _getCachePath(item);
		try {
			let { size } = await IOUtils.stat(path);
			let reader = await _getModule().openStructuredDocumentTextPack({
				byteLength: size,
				read: async (offset, length) => {
					let bytes = await IOUtils.read(path, { offset, maxBytes: length });
					return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				}
			}, { inflate: b => require('pako').inflateRaw(b) });
			let { header } = reader;
			let { processor } = await reader.getMetadata();
			return header.packVersion === expected.SDT_PACK_VERSION
				&& _getSchemaMajorVersion(header.schemaVersion)
					=== _getSchemaMajorVersion(expected.SDT_SCHEMA_VERSION)
				&& processor?.type === processorType
				&& processor?.version === expected.SDT_PROCESSOR_VERSIONS[processorType];
		}
		catch {
			// Missing, or not a pack this module can open
			return false;
		}
	};

	/**
	 * Cut an attachment's structured text into chunks, in the document worker.
	 * Each chunk is as the chunker gives it, with `position`, where the reader
	 * opens it, in place of its positions.
	 *
	 * @param {Integer} itemID
	 * @param {Object} [options] - getPack()'s options
	 * @param {Boolean} [options.segments] - Include each chunk's `segments`,
	 *     its text's structure per text node
	 * @returns {Promise<Object>} - { ok: true, chunks, contentHash }, or
	 *     { ok: false, reason }: getPack()'s reasons or 'cut-failed'
	 */
	this.getItemChunks = async function (itemID, { segments = false, ...options } = {}) {
		let result = await this.getPack(itemID, options);
		if (!result.ok) {
			return { ok: false, reason: result.reason };
		}
		let cut;
		try {
			cut = await Zotero.PDFWorker.getStructuredDocumentTextChunks(
				result.bytes, { isPriority: options.isPriority, segments });
		}
		catch {
			// Logged by the worker manager
			return { ok: false, reason: 'cut-failed' };
		}
		// The worker and the bundled chunker come from the same build, so a
		// mismatch is a build defect, not something to work around
		let version = _getModule().CHUNKER_VERSION;
		if (cut.chunkerVersion !== version) {
			Zotero.logError(new Error(`Document worker chunker version ${cut.chunkerVersion} `
				+ `doesn't match the bundled chunker's ${version}`));
			return { ok: false, reason: 'cut-failed' };
		}
		return { ok: true, chunks: cut.chunks.map(_withFirstPosition), contentHash: cut.sourceHash };
	};

	/**
	 * Cut text with no structure into chunks; blank lines separate paragraphs
	 *
	 * @param {String} text
	 * @param {Object} [options] - The module's chunking options
	 * @returns {Object[]}
	 */
	this.getPlainTextChunks = function (text, options = {}) {
		return _getModule().getPlainTextChunks(text, options);
	};

	/**
	 * A chunk's text as the document's blocks, in text order. A heading block
	 * marks where each later section starts, unless the text has the heading.
	 *
	 * @param {Object} chunk - With `segments` and `sections`
	 * @returns {Object[]|null} - [{ type, start, end, within, ordered?,
	 *     number? }], `within` the types of the enclosing blocks, and
	 *     [{ type: 'heading', outlinePath }]; null without segments
	 */
	this.getChunkBlocks = function (chunk) {
		if (!chunk.segments?.length) {
			return null;
		}
		let blocks = [];
		let starts = (chunk.sections || []).slice(1);
		let last = null;
		for (let segment of chunk.segments) {
			let holder = segment.blocks.at(-1);
			while (starts.length && starts[0].start <= segment.start) {
				let { outlinePath, start } = starts.shift();
				if (!(holder.type == 'heading' && segment.start == start)) {
					blocks.push({ type: 'heading', outlinePath });
					last = null;
				}
			}
			let key = holder.ref.join('.');
			// Same block, or the next part of a paragraph continued across
			// pages, which the text joins without a blank line
			if (last && (last.key == key
					|| last.type == holder.type && !/\n/.test(chunk.text.slice(last.end, segment.start)))) {
				last.end = segment.end;
				continue;
			}
			last = { key, type: holder.type, start: segment.start, end: segment.end,
				within: segment.blocks.slice(0, -1).map(block => block.type) };
			if (holder.type == 'listitem') {
				let list = segment.blocks.at(-2);
				last.ordered = !!list?.ordered;
				last.number = (list?.startIndex ?? 1) + holder.ref.at(-1);
			}
			blocks.push(last);
		}
		return blocks.map(({ key, ...block }) => block);
	};

	/**
	 * The content ranges covering a stretch of a chunk's text: one [start,
	 * end] pair of points [...ref, offset] per segment it overlaps
	 *
	 * @param {Object[]} segments - The chunk's `segments`
	 * @param {Integer} start - Offset into the chunk's text
	 * @param {Integer} end
	 * @param {Object} [options]
	 * @param {String[]} [options.skipBlocks] - Block types to leave out
	 * @returns {Array[]}
	 */
	this.getContentRanges = function (segments, start, end, { skipBlocks = [] } = {}) {
		let point = (segment, offset) => [...segment.ref, segment.offset + offset - segment.start];
		return segments
			.filter(segment => Math.max(start, segment.start) < Math.min(end, segment.end)
				&& !segment.blocks.some(block => skipBlocks.includes(block.type)))
			.map(segment => [point(segment, Math.max(start, segment.start)), point(segment, Math.min(end, segment.end))]);
	};

	/**
	 * Find the reader positions of stretches of an attachment's structured
	 * text, each given as content ranges, in the document worker
	 *
	 * @param {Integer} itemID
	 * @param {Array[][]} selections - Content ranges per stretch
	 * @param {Object} [options] - getPack()'s options
	 * @returns {Promise<Object>} - { ok: true, selections }, each { text,
	 *     outlinePath, sections, pageLabel, positions } or null where its
	 *     ranges don't resolve; or { ok: false, reason }: getPack()'s
	 *     reasons or 'failed'
	 */
	this.locateRanges = async function (itemID, selections, options = {}) {
		let result = await this.getPack(itemID, options);
		if (!result.ok) {
			return { ok: false, reason: result.reason };
		}
		try {
			return {
				ok: true,
				selections: await Zotero.PDFWorker.locateStructuredDocumentTextRanges(
					result.bytes, selections, { isPriority: options.isPriority })
			};
		}
		catch {
			// Logged by the worker manager
			return { ok: false, reason: 'failed' };
		}
	};

	// A chunk with only its first position, where the reader opens it
	function _withFirstPosition({ positions, ...chunk }) {
		return { ...chunk, position: positions?.[0] || null };
	}

	async function _readValidCache({ sourceHash, cachePath, processorType }, options) {
		let bytes;
		try {
			bytes = await IOUtils.read(cachePath);
		}
		catch (e) {
			if (e.name === 'NotFoundError') {
				return { ok: false, reason: 'missing' };
			}
			throw e;
		}
		return _validateBytes(bytes, sourceHash, processorType, options);
	}

	// Validate a pack held in memory, so that the validated bytes can't be
	// affected by concurrent file changes
	async function _validateBytes(bytes, sourceHash, processorType, options = {}) {
		let documentWorkerMetadata = await _getDocumentWorkerMetadata();
		let expectedProcessorVersion = documentWorkerMetadata
			&& documentWorkerMetadata.SDT_PROCESSOR_VERSIONS[processorType];
		if (!expectedProcessorVersion) {
			return { ok: false, reason: 'unavailable' };
		}
		try {
			// openStructuredDocumentTextPack() validates the pack magic and
			// version itself, so a corrupt or unsupported-pack-version cache
			// throws here and is reported as 'invalid-cache'. The schema major
			// version is content semantics that the module deliberately
			// doesn't validate, so check it here
			let reader = await _openPack(bytes);
			let { header } = reader;
			if (header.packVersion !== documentWorkerMetadata.SDT_PACK_VERSION
					|| _getSchemaMajorVersion(header.schemaVersion)
						!== _getSchemaMajorVersion(documentWorkerMetadata.SDT_SCHEMA_VERSION)) {
				return { ok: false, reason: 'unsupported-version' };
			}

			let metadata = await reader.getMetadata();
			if (metadata.source?.hash !== sourceHash) {
				return { ok: false, reason: 'stale-source' };
			}
			if (metadata.processor?.type !== processorType) {
				return { ok: false, reason: 'stale-processor' };
			}
			let staleProcessorVersion = metadata.processor?.version !== expectedProcessorVersion;
			if (staleProcessorVersion
					&& !(options.allowStaleProcessorVersion
						&& _isPositiveInteger(metadata.processor?.version))) {
				return { ok: false, reason: 'stale-processor' };
			}
			return { ok: true, bytes, header, staleProcessorVersion };
		}
		catch (e) {
			return { ok: false, reason: 'invalid-cache', error: e };
		}
	}

	function _makeResult({ bytes, header }) {
		return {
			ok: true,
			// IOUtils.read() and the worker both produce exactly-sized buffers
			bytes: bytes.buffer,
			packVersion: header.packVersion,
			schemaMajorVersion: _getSchemaMajorVersion(header.schemaVersion),
		};
	}

	function _generate(context, options) {
		let key = _getItemKey(context.item);
		let generation = _generating.get(key);
		if (generation) {
			_addGenerationProgressListener(generation, options.onProgress);
			return generation.promise;
		}

		generation = {
			promise: null,
			listeners: new Set(),
			lastProgress: null,
		};
		_addGenerationProgressListener(generation, options.onProgress);

		let promise = _generateUnqueued(context, options, (progress) => {
			_reportGenerationProgress(generation, progress);
		})
			.finally(() => _generating.delete(key));
		generation.promise = promise;
		_generating.set(key, generation);
		return promise;
	}

	function _addGenerationProgressListener(generation, onProgress) {
		if (typeof onProgress !== 'function') {
			return;
		}
		generation.listeners.add(onProgress);
		if (generation.lastProgress !== null) {
			_callProgressListener(onProgress, generation.lastProgress);
		}
	}

	function _reportGenerationProgress(generation, progress) {
		generation.lastProgress = progress;
		for (let listener of generation.listeners) {
			_callProgressListener(listener, progress);
		}
	}

	function _callProgressListener(onProgress, progress) {
		try {
			onProgress(progress);
		}
		catch {
			// Progress reporting is best-effort and must not affect extraction.
		}
	}

	async function _generateUnqueued({ item, sourceHash, cachePath, processorType }, options, onProgress) {
		try {
			if (_passwordFailures.get(_getItemKey(item)) === sourceHash) {
				return { ok: false, reason: 'password-required' };
			}
			let t = new Date();
			let result = await Zotero.PDFWorker.getStructuredDocumentText(item.id, {
				isPriority: !!options.isPriority,
				onProgress,
			});
			if (!result?.buf) {
				return { ok: false, reason: 'failed' };
			}
			let bytes = new Uint8Array(result.buf);
			// Validate against the file's current hash rather than the one
			// captured above, since the file can change while the extraction
			// job waits in the worker queue and the worker stamps the hash it
			// computes at processing time
			let currentHash = await _getSourceHash(item) || sourceHash;
			let cache = await _validateBytes(bytes, currentHash, processorType);
			if (!cache.ok) {
				Zotero.debug(`Generated SDT pack for item ${item.libraryKey} is unusable: ${cache.reason}`);
				return { ok: false, reason: 'failed' };
			}
			// Don't use Zotero.Attachments.createDirectoryForItem() here -- it
			// deletes and recreates the directory, which would destroy other
			// files stored there (e.g., the full-text cache of a linked file)
			await Zotero.File.createDirectoryIfMissingAsync(PathUtils.parent(cachePath));
			await IOUtils.write(cachePath, bytes, { tmpPath: `${cachePath}.tmp` });
			Zotero.debug(
				`Generated SDT pack for item ${item.libraryKey} in ${new Date() - t} ms `
				+ `(${bytes.byteLength} bytes)`
			);
			return _makeResult(cache);
		}
		catch (e) {
			if (_isPasswordError(e)) {
				_passwordFailures.set(_getItemKey(item), sourceHash);
				return { ok: false, reason: 'password-required' };
			}
			Zotero.logError(e);
			return { ok: false, reason: 'failed' };
		}
	}

	async function _openPack(bytes) {
		let SDT = _getModule();
		let pako = require('pako');
		let source = {
			byteLength: bytes.byteLength,
			read: async (offset, length) => bytes.buffer.slice(
				bytes.byteOffset + offset,
				bytes.byteOffset + offset + length
			),
		};
		return SDT.openStructuredDocumentTextPack(source, {
			inflate: b => pako.inflateRaw(b),
		});
	}

	async function _getDocumentWorkerMetadata() {
		if (_documentWorkerMetadata) {
			return _documentWorkerMetadata;
		}
		try {
			let metadata = JSON.parse(
				await Zotero.File.getContentsFromURLAsync(DOCUMENT_WORKER_METADATA_URL)
			);
			_validateDocumentWorkerMetadata(metadata);
			_documentWorkerMetadata = metadata;
			return metadata;
		}
		catch (e) {
			if (!_documentWorkerMetadataErrorLogged) {
				_documentWorkerMetadataErrorLogged = true;
				Zotero.logError(e);
			}
			return null;
		}
	}

	function _validateDocumentWorkerMetadata(metadata) {
		let SDT = _getModule();
		if (!metadata || typeof metadata !== 'object') {
			throw new Error('Invalid document-worker metadata');
		}
		if (typeof metadata.SDT_SCHEMA_VERSION !== 'string'
				|| !_isPositiveInteger(metadata.SDT_PACK_VERSION)
				|| !metadata.SDT_PROCESSOR_VERSIONS
				|| typeof metadata.SDT_PROCESSOR_VERSIONS !== 'object') {
			throw new Error('Invalid document-worker metadata');
		}
		for (let processorType of ['pdf', 'epub', 'snapshot']) {
			if (!_isPositiveInteger(metadata.SDT_PROCESSOR_VERSIONS[processorType])) {
				throw new Error('Invalid document-worker processor metadata');
			}
		}
		if (!SDT
				|| metadata.SDT_SCHEMA_VERSION !== SDT.SDT_SCHEMA_VERSION
				|| metadata.SDT_PACK_VERSION !== SDT.SDT_PACK_VERSION) {
			throw new Error('Document-worker metadata does not match the bundled SDT reader');
		}
	}

	function _getCachePath(item) {
		return PathUtils.join(Zotero.Attachments.getStorageDirectory(item).path, SDT_CACHE_FILE_NAME);
	}

	async function _getAttachmentContext(itemID) {
		// getAsync() returns false, not null, for a nonexistent item. The item
		// is only read, so it isn't added to the cache.
		let item = await Zotero.Items.getAsync(itemID, { noCache: true });
		if (!item || !item.isAttachment()) {
			return { ok: false, reason: 'unavailable' };
		}
		// The type checks exclude linked-URL attachments, and _getSourceHash()
		// returns null when the attachment has no readable file
		let processorType = _getProcessorType(item);
		if (!processorType) {
			return { ok: false, reason: 'unavailable' };
		}
		let sourceHash = await _getSourceHash(item);
		if (!sourceHash) {
			return { ok: false, reason: 'unavailable' };
		}
		return {
			ok: true,
			item,
			sourceHash,
			processorType,
			cachePath: _getCachePath(item),
		};
	}

	function _getProcessorType(item) {
		if (item.isPDFAttachment()) {
			return 'pdf';
		}
		if (item.isEPUBAttachment()) {
			return 'epub';
		}
		if (item.isSnapshotAttachment()) {
			return 'snapshot';
		}
		return null;
	}

	function _getSchemaMajorVersion(schemaVersion) {
		return Number(String(schemaVersion).split('.')[0]);
	}

	function _getItemKey(item) {
		return `${item.libraryID}/${item.key}`;
	}

	function _isPositiveInteger(value) {
		return Number.isInteger(value) && value > 0;
	}

	async function _getSourceHash(item) {
		try {
			// attachmentHash reads and hashes the whole file, so reuse the
			// result as long as the file's path, size, and mtime are unchanged
			let path = await item.getFilePathAsync();
			if (!path) {
				return null;
			}
			let { size, lastModified } = await IOUtils.stat(path);
			let cached = _sourceHashCache.get(item.id);
			if (cached
					&& cached.path === path
					&& cached.size === size
					&& cached.mtime === lastModified) {
				return cached.hash;
			}
			let hash = await item.attachmentHash;
			if (hash) {
				_sourceHashCache.set(item.id, { path, size, mtime: lastModified, hash });
			}
			return hash;
		}
		catch (e) {
			if (e.name !== 'NotFoundError') {
				Zotero.logError(e);
			}
			return null;
		}
	}

	function _isPasswordError(e) {
		// Password-protected documents aren't supported, but the failure is
		// classified as 'password-required' so that the reason can be shown
		// to the user. (PDFWorker restores the error name from the worker
		// error JSON.)
		return e?.name === 'PasswordException';
	}
};

/**
 * Zotero.SDT.AutoIndex -- extract eligible attachments' structured text in
 * the background while the sdt.autoExtract pref is on
 */
Zotero.SDT.AutoIndex = new function () {
	// Debounce before a sweep starts, so a burst of saved attachments (an
	// import, a sync) is taken in one
	const KICK_DELAY = 3000;
	// Before the first sweep of a session, out of the way of startup
	const STARTUP_DELAY = 10000;
	// While a sweep runs, how often listeners hear of its progress
	const NOTIFY_INTERVAL = 500;

	let _initialized = false;
	let _sweeping = null;
	let _kicked = false;
	let _kickTimer = null;
	// Attachments done this session, extracted or not, until they're saved again
	let _settled = new Set();
	// Eligible attachments as the last count found them, null before one
	let _total = null;
	let _listeners = new Set();
	let _notifiedAt = 0;

	/**
	 * Sweep at startup, and after attachments are saved or a sync finishes
	 */
	this.init = function () {
		if (_initialized) {
			return;
		}
		_initialized = true;
		Zotero.Prefs.registerObserver('sdt.autoExtract', () => {
			_notify();
			this.kick();
		});
		Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (type == 'sync') {
					if (event == 'finish') {
						this.kick();
					}
					return;
				}
				if (event == 'add' || event == 'modify') {
					// A saved attachment may have a new file, or its first
					for (let id of ids) {
						_settled.delete(id);
					}
					this.kick();
				}
			}
		}, ['item', 'sync'], 'sdtAutoIndex');
		this.kick(STARTUP_DELAY);
	};

	/**
	 * @return {Boolean}
	 */
	this.isEnabled = function () {
		return !!Zotero.Prefs.get('sdt.autoExtract');
	};

	/**
	 * Sweep after a delay, so a burst of kicks makes one sweep
	 *
	 * @param {Number} [delay=KICK_DELAY] - Milliseconds
	 */
	this.kick = function (delay = KICK_DELAY) {
		if (!this.isEnabled()) {
			return;
		}
		if (_kickTimer) {
			clearTimeout(_kickTimer);
		}
		_kickTimer = setTimeout(() => {
			_kickTimer = null;
			this.sweep();
		}, delay);
	};

	/**
	 * @return {Object} - { enabled, sweeping, settled, total }, `total` null
	 *     until counted
	 */
	this.getStatus = function () {
		return {
			enabled: this.isEnabled(),
			sweeping: !!_sweeping,
			settled: _settled.size,
			total: _total
		};
	};

	/**
	 * Count the eligible attachments if not yet counted, and notify listeners
	 *
	 * @return {Promise<Object>} - getStatus()
	 */
	this.refreshStatus = async function () {
		if (_total === null) {
			_total = (await _getEligibleIDs()).length;
		}
		_notify();
		return this.getStatus();
	};

	/**
	 * @param {Function} fn - Called with getStatus() as a sweep progresses
	 */
	this.addListener = function (fn) {
		_listeners.add(fn);
	};

	this.removeListener = function (fn) {
		_listeners.delete(fn);
	};

	/**
	 * Sweep now, including attachments already done this session
	 *
	 * @return {Promise}
	 */
	this.restart = function () {
		_settled.clear();
		_notify();
		if (_kickTimer) {
			clearTimeout(_kickTimer);
			_kickTimer = null;
		}
		return this.sweep();
	};

	/**
	 * Sweep now, extracting attachments with no current pack, or join the
	 * sweep already running
	 *
	 * @return {Promise}
	 */
	this.sweep = function () {
		if (_sweeping) {
			_kicked = true;
			return _sweeping;
		}
		_sweeping = _sweep()
			.catch(e => Zotero.logError(e))
			.finally(() => {
				_sweeping = null;
				_notify();
				if (_kicked) {
					_kicked = false;
					this.kick();
				}
			});
		return _sweeping;
	};

	// PDFs and EPUBs with a file and imported snapshots, in user and group
	// libraries
	async function _getEligibleIDs() {
		let libraryIDs = Zotero.Libraries.getAll()
			.filter(library => ['user', 'group'].includes(library.libraryType))
			.map(library => library.libraryID);
		return Zotero.DB.columnQueryAsync(
			"SELECT itemID FROM itemAttachments IA JOIN items I USING (itemID) "
				+ "WHERE ((IA.contentType IN ('application/pdf', 'application/epub+zip') "
					+ "AND IA.linkMode!=" + Zotero.Attachments.LINK_MODE_LINKED_URL + ") "
					+ "OR (IA.contentType='text/html' "
						+ "AND IA.linkMode=" + Zotero.Attachments.LINK_MODE_IMPORTED_URL + ")) "
				+ "AND I.libraryID IN (" + (libraryIDs.join(',') || 'NULL') + ") "
				+ "ORDER BY I.itemID"
		);
	}

	function _notify() {
		_notifiedAt = Date.now();
		let status = Zotero.SDT.AutoIndex.getStatus();
		for (let fn of _listeners) {
			try {
				fn(status);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	}

	async function _sweep() {
		let started = Date.now();
		let extracted = 0;
		let eligibleIDs = await _getEligibleIDs();
		// Attachments gone since, or no longer eligible, don't count
		let eligible = new Set(eligibleIDs);
		_settled = new Set([..._settled].filter(id => eligible.has(id)));
		_total = eligibleIDs.length;
		_notify();
		for (let itemID of eligibleIDs) {
			if (!Zotero.SDT.AutoIndex.isEnabled()) {
				break;
			}
			if (_settled.has(itemID)) {
				continue;
			}
			// Reads only the pack's header, so an extracted library is cheap
			// to go over
			if (!await Zotero.SDT.isCurrent(itemID)) {
				// Done whatever the outcome, until the attachment is saved again
				if (await Zotero.SDT.ensure(itemID)) {
					extracted++;
				}
			}
			_settled.add(itemID);
			if (Date.now() - _notifiedAt >= NOTIFY_INTERVAL) {
				_notify();
			}
		}
		if (extracted) {
			Zotero.debug(`SDT: sweep extracted ${extracted} `
				+ Zotero.Utilities.pluralize(extracted, 'attachment')
				+ ` in ${Math.round((Date.now() - started) / 1000)} s`);
		}
	}
};
