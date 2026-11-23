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

/**
 * Zotero.MCP.Text -- an attachment's text for the MCP tools, as chunks or a PDF's pages
 *
 * Text comes from the file's structure when Zotero has it, and from its full text
 * otherwise. Text from the structure has an ID before each sentence, e.g. 'c7.3' (chunk 7,
 * sentence 3) or 'p12.4' (page 12, sentence 4), which resolves back to the sentence.
 */
Zotero.MCP.Text = new function () {
	const TIMED_OUT = Zotero.MCP.TIMED_OUT;
	// Pages extracted from a PDF at a time beyond those Zotero indexed
	const EXTRACT_PAGES = 10;
	const TEXT_PENDING = 'Zotero is still getting the text from the file. Try again shortly.';
	const STRUCTURE_PENDING = "Zotero is still working out the file's structure, so for now its text "
		+ 'is plain, without sections, page labels or places to open at, and its chunks change '
		+ "once Zotero has it. Its sentences have no IDs, as Zotero can't find them in the file "
		+ "without the structure, so they can't be cited with zotero_ground_response or annotated "
		+ 'yet. Call again shortly.';
	const NO_STRUCTURE = "Zotero doesn't have this file's structure, so its text is plain, without "
		+ "sections, page labels or places to open at. Its sentences have no IDs, as Zotero can't "
		+ "find them in the file without the structure, so they can't be cited with "
		+ 'zotero_ground_response or annotated.';
	// 'c' and a chunk's index or 'p' and a page's number, and the sentence's number there
	const SENTENCE_ID_RE = /^([cp])(\d+)\.(\d+)$/;

	/**
	 * Zotero is still getting the text from the file
	 */
	class TextPendingError extends Zotero.MCP.ToolError {
		constructor() {
			super(TEXT_PENDING);
		}
	}
	this.TextPendingError = TextPendingError;

	/**
	 * Zotero doesn't have the file's structure, so it can't find sentences in it
	 */
	class NoStructureError extends Zotero.MCP.ToolError {
		constructor(attachment) {
			super(`Zotero doesn't have the structure of ${attachment.key}, so it can't find `
				+ 'sentences in it. Read it again with zotero_read_text, and use the sentence IDs it '
				+ 'gives.');
		}
	}

	// Longest a call waits for a file's structure to be extracted, within its deadline.
	// Extraction goes on after that, so a later call has it.
	this._structureWait = 15 * 1000;

	/**
	 * An attachment's chunks, cut along its structure or else from its full text
	 *
	 * @param {Zotero.Item} attachment
	 * @param {Object} options
	 * @param {Number} options.deadline - When to stop waiting for the text
	 * @param {Number} [options.structureDeadline] - When to stop waiting for the structure.
	 *     Defaults to _structureWait from now.
	 * @param {Boolean} [options.structureOnly] - Give null chunks rather than cut the full text
	 * @return {Promise<Object>} { chunks, plain, notice, pending }: `plain` for chunks of the
	 *     full text, `pending` while the structure is being extracted
	 * @throws {Zotero.MCP.ToolError} If there's no text, or it isn't ready
	 */
	this.getChunks = async function (attachment, { deadline, structureDeadline, structureOnly = false }) {
		let structure = await _getStructureChunks(
			attachment,
			structureDeadline ?? Math.min(deadline, Date.now() + this._structureWait)
		);
		if (structure.chunks) {
			return { chunks: structure.chunks, plain: false, pending: false };
		}
		if (structureOnly) {
			return { chunks: null, plain: false, pending: !!structure.pending };
		}
		let text = await _getIndexedText(attachment, deadline);
		if (text === TIMED_OUT) {
			throw new TextPendingError();
		}
		if (!text?.trim()) {
			throw new Zotero.MCP.ToolError(!await attachment.fileExists()
				? `The file of ${attachment.key} isn't on this computer, and Zotero has no text for it`
				: `Zotero couldn't get any text from the file of ${attachment.key}`
					+ (attachment.isPDFAttachment() ? '. If the PDF is scanned, it may need OCR.' : ''));
		}
		let { indexedChars, totalChars, indexedPages, totalPages } = await Zotero.DB.rowQueryAsync(
			'SELECT indexedChars, totalChars, indexedPages, totalPages FROM fulltextItems WHERE itemID=?',
			attachment.id
		) || {};
		return {
			chunks: Zotero.SDT.getPlainTextChunks(text),
			plain: true,
			notice: [
				structure.pending ? STRUCTURE_PENDING : NO_STRUCTURE,
				indexedPages < totalPages
					&& `Zotero has the text of only the first ${indexedPages} of ${totalPages} pages.`,
				indexedChars < totalChars
					&& `Zotero has only the first ${indexedChars} of ${totalChars} characters.`,
			].filter(Boolean).join(' '),
			pending: !!structure.pending,
		};
	};

	/**
	 * Pages of a PDF, from its structure or else from its full text
	 *
	 * @param {Zotero.Item} attachment
	 * @param {Array<Integer|String>} pages - Page numbers, from 1, or page labels, which the
	 *     full text doesn't have
	 * @param {Object} options
	 * @param {Number} options.deadline - When to stop waiting
	 * @return {Promise<Object>} { pages, plain, totalPages, pending, notice }: `pages` in
	 *     order, each with `page` and `text`; `plain` for pages of the full text; `pending`
	 *     the numbers of pages still being extracted
	 * @throws {Zotero.MCP.ToolError} For pages the PDF doesn't have, or text that isn't ready
	 */
	this.getPages = async function (attachment, pages, { deadline }) {
		if (!attachment.isPDFAttachment()) {
			throw new Zotero.MCP.ToolError(`${attachment.key} has no pages. Read it by chunk.`);
		}
		let structure = await _getStructurePages(
			attachment,
			pages,
			Math.min(deadline, Date.now() + this._structureWait)
		);
		if (structure.pages) {
			if (structure.missing.length) {
				throw new Zotero.MCP.ToolError(`${attachment.key} has no page ${structure.missing.join(', ')}`);
			}
			return {
				pages: structure.pages.map(page => ({ ...page, page: page.pageIndex + 1 })),
				plain: false,
				totalPages: structure.totalPages,
				pending: [],
			};
		}
		if (pages.some(page => typeof page != 'number')) {
			throw new Zotero.MCP.ToolError(structure.pending
				? `Zotero is still working out the pages of ${attachment.key}, so it can't find them by `
					+ 'label yet. Try again shortly, or give page numbers.'
				: `Zotero has no page labels for ${attachment.key}. Give page numbers.`);
		}
		let fulltext = await _getFulltextPages(attachment, [...new Set(pages)].sort((a, b) => a - b), deadline);
		return {
			pages: fulltext.pages,
			plain: true,
			totalPages: fulltext.totalPages,
			pending: fulltext.pending,
			notice: [
				structure.pending ? STRUCTURE_PENDING : NO_STRUCTURE,
				fulltext.pending.length && TEXT_PENDING,
			].filter(Boolean).join(' '),
		};
	};

	/**
	 * A chunk's or a page's text as Markdown, with an ID before each sentence, e.g. '[c7.3] '.
	 * A heading has no ID, a code or math block has one, and a block Markdown has no form
	 * for is tagged with its type, e.g. '(caption) '.
	 *
	 * @param {Object} unit - A chunk or page
	 * @param {Object} [id] - { chunk }, its index, or { page }, its number. Without it,
	 *     sentences get no IDs.
	 * @return {String}
	 */
	this.getMarkdown = function (unit, id) {
		let prefix = id && (id.chunk !== undefined ? 'c' + id.chunk : 'p' + id.page);
		// A sentence's ID before what's read by it
		let withID = (sentence, text, separator = ' ') => (prefix
			? `[${prefix}.${sentence.number}]${separator}${text}`
			: text);
		let cite = sentences => sentences
			.map(sentence => withID(sentence, unit.text.slice(sentence.start, sentence.end).replace(/\s+/g, ' ')))
			.join(' ');
		let sections = unit.sections || [];
		let heading = (depth, text) => '#'.repeat(Math.min(Math.max(depth, 1), 6)) + ' ' + text;
		let blocks = Zotero.SDT.getChunkBlocks(unit).map((block) => {
			// Where a section starts without its heading in the text
			if (block.outlinePath) {
				return heading(block.outlinePath.length, block.outlinePath.at(-1));
			}
			if (block.type == 'heading') {
				// A heading that isn't in the outline is under the section it's in
				let starting = sections.find(section => section.start == block.start);
				let within = sections.findLast(section => section.start <= block.start);
				let depth = starting ? starting.outlinePath.length : (within?.outlinePath.length ?? 0) + 1;
				return heading(depth, unit.text.slice(block.start, block.end).replace(/\s+/g, ' '));
			}
			if (block.rows) {
				return block.rows
					.map(row => '| ' + row.map(cell => cite(cell.sentences)).join(' | ') + ' |')
					.join('\n');
			}
			let markdown;
			if (block.type == 'preformatted') {
				markdown = withID(block.sentences[0], '```\n' + unit.text.slice(block.start, block.end) + '\n```', '\n');
			}
			else if (block.type == 'math') {
				markdown = withID(block.sentences[0], '$$' + unit.text.slice(block.start, block.end) + '$$');
			}
			else {
				markdown = cite(block.sentences);
				if (block.type == 'listitem') {
					let indent = '  '.repeat(Math.max(0, (block.within || []).filter(type => type == 'list').length - 1));
					markdown = indent + (block.ordered ? block.number + '.' : '-') + ' ' + markdown;
				}
				else if (block.type != 'paragraph' && block.type != 'blockquote') {
					markdown = `(${block.type}) ${markdown}`;
				}
			}
			if (block.within?.includes('note')) {
				markdown = '(note) ' + markdown;
			}
			if (block.type == 'blockquote' || block.within?.includes('blockquote')) {
				markdown = markdown.split('\n').map(line => '> ' + line).join('\n');
			}
			return markdown;
		});
		return blocks.join('\n\n');
	};

	/**
	 * Parse sentence IDs
	 *
	 * @param {String[]} ids - E.g. ['c7.3', 'p12.4']
	 * @return {Object[]} Per ID, { chunk, sentence, id } or { page, sentence, id }
	 * @throws {Zotero.MCP.ToolError} For an ID that isn't one
	 */
	this.parseSentenceIDs = function (ids) {
		let invalid = ids.filter(id => !SENTENCE_ID_RE.test(id));
		if (invalid.length) {
			throw new Zotero.MCP.ToolError(`${invalid.join(', ')} isn't a sentence ID, e.g. c7.3 or p12.4`);
		}
		return ids.map((id) => {
			let [, kind, unit, sentence] = SENTENCE_ID_RE.exec(id);
			return { [kind == 'c' ? 'chunk' : 'page']: parseInt(unit), sentence: parseInt(sentence), id };
		});
	};

	/**
	 * The text and content ranges of cited sentences, found in the file's cached structure
	 *
	 * @param {Zotero.Item} attachment
	 * @param {Object[][]} citations - Per citation, its parsed sentence IDs
	 * @param {Object} options
	 * @param {Number} options.deadline - When to stop waiting
	 * @return {Promise<Object[]>} Per citation, { text, runs }: the text in the file's order,
	 *     with ' … ' between sentences apart, and the content ranges of each run of adjacent
	 *     sentences. Or { missing }, the first sentence that isn't there.
	 * @throws {Zotero.MCP.ToolError} Without the file's structure
	 */
	this.getCitedSentences = async function (attachment, citations, { deadline }) {
		let all = citations.flat();
		let pageNumbers = [...new Set(all.filter(cited => cited.page !== undefined).map(cited => cited.page))];
		if (pageNumbers.length && !attachment.isPDFAttachment()) {
			throw new Zotero.MCP.ToolError(`${attachment.key} has no pages`);
		}
		let chunks = [];
		if (all.some(cited => cited.chunk !== undefined)) {
			let cut = await _getStructureChunks(attachment, deadline, { cachedOnly: true });
			if (cut.pending) {
				throw new TextPendingError();
			}
			if (!cut.chunks) {
				throw new NoStructureError(attachment);
			}
			chunks = cut.chunks;
		}
		let pages = new Map();
		if (pageNumbers.length) {
			let read = await _getStructurePages(attachment, pageNumbers, deadline, { cachedOnly: true });
			if (read.pending) {
				throw new TextPendingError();
			}
			if (!read.pages) {
				throw new NoStructureError(attachment);
			}
			read.pages.forEach(page => pages.set(page.pageIndex + 1, page));
		}
		return _resolveSentences(citations, chunks, pages);
	};

	/**
	 * Cited sentences with their positions in the file
	 *
	 * @param {Zotero.Item} attachment
	 * @param {Object[][]} citations - Per citation, its parsed sentence IDs
	 * @param {Object} options
	 * @param {Number} options.deadline - When to stop waiting
	 * @return {Promise<Object[]>} Per citation, { text, positions, outlinePath, pageLabel },
	 *     { missing } or { unresolved: true }
	 * @throws {Zotero.MCP.ToolError} Without the file's structure
	 */
	this.locateSentences = async function (attachment, citations, { deadline }) {
		let cited = await this.getCitedSentences(attachment, citations, { deadline });
		let runs = cited.flatMap(result => result.runs || []);
		let selections = [];
		if (runs.length) {
			let located = await Zotero.MCP.untilDeadline(
				Zotero.SDT.locateRanges(attachment.id, runs, { cachedOnly: true, isPriority: true }),
				deadline
			);
			if (located === TIMED_OUT) {
				throw new TextPendingError();
			}
			if (!located.ok) {
				throw new NoStructureError(attachment);
			}
			selections = located.selections;
		}
		let next = 0;
		return cited.map((result) => {
			if (result.missing) {
				return result;
			}
			let located = selections.slice(next, next + result.runs.length).filter(Boolean);
			next += result.runs.length;
			if (!located.length) {
				return { unresolved: true };
			}
			return {
				text: result.text,
				positions: located.flatMap(selection => selection.positions),
				outlinePath: located[0].sections[0].outlinePath,
				pageLabel: located[0].pageLabel,
			};
		});
	};

	/**
	 * Cited sentences' text and content ranges, by their numbers in their chunks and pages
	 *
	 * @param {Object[][]} citations - Per citation, its parsed sentence IDs
	 * @param {Object[]} chunks - The file's, by index
	 * @param {Map} pages - The cited ones, by number
	 * @return {Object[]} Per citation, { text, runs } or { missing }
	 */
	function _resolveSentences(citations, chunks, pages) {
		let sentencesOf = new Map();
		let getSentences = (unit) => {
			if (!sentencesOf.has(unit)) {
				sentencesOf.set(unit, Zotero.SDT.getSentences(unit));
			}
			return sentencesOf.get(unit);
		};
		let isPage = cited => cited.chunk === undefined;
		let unitNumber = cited => cited.chunk ?? cited.page;
		// A chunk whose text couldn't be placed in the file has no segments, so no ranges
		let rangesOf = (unit, start, end) => Zotero.SDT.getContentRanges(unit.segments || [], start, end);
		// Whether a sentence is the next one after another: in its chunk or page, or the
		// first of the next one after the last of this one
		let follows = (a, b) => isPage(a.cited) == isPage(b.cited) && (a.unit === b.unit
			? b.cited.sentence == a.cited.sentence + 1
			: unitNumber(b.cited) == unitNumber(a.cited) + 1 && b.cited.sentence == 1
				&& a.cited.sentence == getSentences(a.unit).length);
		return citations.map((citation) => {
			let found = [];
			for (let cited of citation) {
				let unit = isPage(cited) ? pages.get(cited.page) : chunks[cited.chunk];
				let extent = unit && getSentences(unit)[cited.sentence - 1];
				if (!extent) {
					return { missing: cited };
				}
				found.push({ cited, unit, extent });
			}
			found.sort((a, b) => isPage(a.cited) - isPage(b.cited)
				|| unitNumber(a.cited) - unitNumber(b.cited)
				|| a.cited.sentence - b.cited.sentence);
			// Per run, the stretches of its chunks or pages it covers
			let runs = [];
			let seen = new Set();
			let text = '';
			let previous = null;
			for (let sentence of found) {
				let { unit, extent } = sentence;
				let keys = rangesOf(unit, extent.start, extent.end).map(range => JSON.stringify(range));
				// Cited twice, as from a chunk and a page
				if (keys.every(key => seen.has(key))) {
					continue;
				}
				keys.forEach(key => seen.add(key));
				let adjacent = previous && follows(previous, sentence);
				text += (text ? (adjacent ? ' ' : ' … ') : '')
					+ unit.text.slice(extent.start, extent.end).replace(/\s+/g, ' ');
				if (adjacent && previous.unit === unit) {
					runs.at(-1).at(-1).end = extent.end;
				}
				else if (adjacent) {
					runs.at(-1).push({ unit, start: extent.start, end: extent.end });
				}
				else {
					runs.push([{ unit, start: extent.start, end: extent.end }]);
				}
				previous = sentence;
			}
			return {
				text,
				runs: runs.map(run => run.flatMap(({ unit, start, end }) => rangesOf(unit, start, end))),
			};
		});
	}

	/**
	 * Whether Zotero can extract the structure of an attachment's file
	 */
	function _canHaveStructure(attachment) {
		return attachment.isPDFAttachment() || attachment.isEPUBAttachment()
			|| attachment.isSnapshotAttachment();
	}

	/**
	 * An attachment's structured text cut into chunks
	 *
	 * @param {Number} deadline - When to stop waiting. Extraction goes on after it.
	 * @param {Object} [options]
	 * @param {Boolean} [options.cachedOnly] - Don't extract the structure
	 * @return {Promise<Object>} { chunks, pending }: `chunks` null without a structure,
	 *     `pending` past the deadline
	 */
	async function _getStructureChunks(attachment, deadline, { cachedOnly = false } = {}) {
		if (!_canHaveStructure(attachment)) {
			return { chunks: null };
		}
		let result = await Zotero.MCP.untilDeadline(Zotero.SDT.getItemChunks(attachment.id, {
			isPriority: true,
			segments: true,
			cachedOnly,
		}), deadline);
		if (result === TIMED_OUT) {
			return { chunks: null, pending: true };
		}
		if (!result.ok || !result.chunks.length) {
			return { chunks: null };
		}
		return { chunks: result.chunks };
	}

	/**
	 * Pages of a PDF's structured text
	 *
	 * @param {Number} deadline - When to stop waiting. Extraction goes on after it.
	 * @param {Object} [options]
	 * @param {Boolean} [options.cachedOnly] - Don't extract the structure
	 * @return {Promise<Object>} { pages, missing, totalPages, pending }: `pages` null without
	 *     a structure, `pending` past the deadline
	 */
	async function _getStructurePages(attachment, pages, deadline, { cachedOnly = false } = {}) {
		let result = await Zotero.MCP.untilDeadline(
			Zotero.SDT.getPages(attachment.id, pages, { isPriority: true, cachedOnly }),
			deadline
		);
		if (result === TIMED_OUT) {
			return { pages: null, pending: true };
		}
		if (!result.ok) {
			return { pages: null };
		}
		return { pages: result.pages, missing: result.missing, totalPages: result.totalPages };
	}

	/**
	 * An attachment's full text, indexing the file if it hasn't been, or a text file's
	 * contents
	 *
	 * @param {Number} deadline - When to stop waiting for indexing
	 * @return {Promise<String|null|Symbol>} Null without text, TIMED_OUT past the deadline
	 */
	async function _getIndexedText(attachment, deadline) {
		if (!Zotero.FullText.isCachedMIMEType(attachment.attachmentContentType)) {
			let path = await attachment.getFilePathAsync();
			return path ? Zotero.File.getContentsAsync(path, attachment.attachmentCharset) : null;
		}
		let path = Zotero.FullText.getItemCacheFile(attachment).path;
		if (!await IOUtils.exists(path) && await attachment.fileExists()
				&& await Zotero.MCP.untilDeadline(Zotero.FullText.indexItems([attachment.id]), deadline) === TIMED_OUT) {
			return TIMED_OUT;
		}
		return await IOUtils.exists(path) ? Zotero.File.getContentsAsync(path) : null;
	}

	/**
	 * Text of PDF pages from the full text, and of pages past it from the file
	 *
	 * @param {Integer[]} pageNumbers - From 1, in order
	 * @return {Promise<Object>} { pages: [{ page, text }], pending, totalPages }: `pending`
	 *     the numbers of pages not extracted by the deadline
	 * @throws {Zotero.MCP.ToolError} For pages the PDF doesn't have, or text that isn't ready
	 */
	async function _getFulltextPages(attachment, pageNumbers, deadline) {
		let text = await _getIndexedText(attachment, deadline);
		// The PDF worker separates pages with form feeds
		let texts = typeof text == 'string' ? text.split('\f') : [];
		let totalPages = (await Zotero.FullText.getPages(attachment.id))?.total;
		if (!totalPages) {
			if (!await attachment.fileExists()) {
				throw new Zotero.MCP.ToolError(`The file of ${attachment.key} isn't on this computer, and `
					+ 'Zotero has no text for it');
			}
			let extracted = await _extractPages(attachment, [0], deadline);
			if (extracted === TIMED_OUT) {
				throw new TextPendingError();
			}
			totalPages = extracted.totalPages;
			texts[0] = extracted.texts[0];
		}
		let missing = pageNumbers.filter(page => page > totalPages);
		if (missing.length) {
			throw new Zotero.MCP.ToolError(`${attachment.key} has ${totalPages} pages, so no page `
				+ missing.join(', '));
		}
		let pages = [];
		let pending = [];
		for (let page of pageNumbers) {
			// Such as pages past the index limit (the fulltext.pdfMaxPages pref), a batch at a time
			if (texts[page - 1] === undefined && !pending.length) {
				let pageIndexes = [];
				for (let i = page - 1; i < Math.min(totalPages, page - 1 + EXTRACT_PAGES); i++) {
					pageIndexes.push(i);
				}
				let extracted = await _extractPages(attachment, pageIndexes, deadline);
				if (extracted !== TIMED_OUT) {
					pageIndexes.forEach((pageIndex, i) => {
						texts[pageIndex] = extracted.texts[i] ?? '';
					});
				}
			}
			if (texts[page - 1] === undefined) {
				pending.push(page);
			}
			else {
				pages.push({ page, text: texts[page - 1].trim() });
			}
		}
		return { pages, pending, totalPages };
	}

	/**
	 * Text of PDF pages, from the file
	 *
	 * @param {Integer[]} pageIndexes - Consecutive
	 * @param {Number} deadline - When to stop waiting
	 * @return {Promise<Object|Symbol>} { texts, totalPages }, or TIMED_OUT
	 */
	async function _extractPages(attachment, pageIndexes, deadline) {
		let result = await Zotero.MCP.untilDeadline(
			Zotero.PDFWorker.getFullText(attachment.id, pageIndexes, true),
			deadline
		);
		if (result === TIMED_OUT) {
			return result;
		}
		return { texts: result.text.split('\f'), totalPages: result.totalPages };
	}
};
