"use strict";

describe("Zotero.MCP.Text", function () {
	afterEach(function () {
		sinon.restore();
	});

	async function importText(contents) {
		let path = PathUtils.join(await getTempDirectory(), 'plain.txt');
		await Zotero.File.putContentsAsync(path, contents);
		return Zotero.Attachments.importFromFile({ file: path });
	}

	describe("#getChunks()", function () {
		it("should give the chunks of an attachment's structure, extracting it", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let getItemChunks = sinon.stub(Zotero.SDT, 'getItemChunks').resolves({
				ok: true,
				chunks: [makeTestChunk(['One.']), makeTestChunk(['Two.'])],
			});

			let result = await Zotero.MCP.Text.getChunks(attachment, { deadline: Date.now() + 10000 });
			assert.deepEqual(result.chunks.map(chunk => chunk.text), ['One.', 'Two.']);
			assert.isFalse(result.pending);
			assert.isFalse(result.plain);
			assert.isUndefined(result.notice);
			assert.isTrue(getItemChunks.calledWith(attachment.id, { isPriority: true, segments: true, cachedOnly: false }));
		});

		it("should cut the full text until the structure is extracted", async function () {
			let attachment = await importFileAttachment('test.pdf');
			sinon.stub(Zotero.SDT, 'getItemChunks').returns(new Promise(() => {}));

			let result = await Zotero.MCP.Text.getChunks(attachment, {
				deadline: Date.now() + 10000,
				structureDeadline: Date.now() + 50,
			});
			assert.isTrue(result.pending);
			assert.isTrue(result.plain);
			assert.include(result.chunks[0].text, 'Zotero');
			assert.match(result.notice, /still working out the file's structure.*sentences have no IDs/);
		});

		it("should cut the text of a file without structure, and say its sentences have no IDs", async function () {
			let attachment = await importText('Plain text');
			let result = await Zotero.MCP.Text.getChunks(attachment, { deadline: Date.now() + 10000 });
			assert.deepEqual(result.chunks.map(chunk => chunk.text), ['Plain text']);
			assert.isFalse(result.pending);
			assert.isTrue(result.plain);
			assert.match(result.notice, /doesn't have this file's structure.*sentences have no IDs/);
		});

		it("should say when there's no text", async function () {
			let attachment = await importText(' ');
			let error = await getPromiseError(Zotero.MCP.Text.getChunks(attachment, { deadline: Date.now() + 10000 }));
			assert.instanceOf(error, Zotero.MCP.ToolError);
			assert.include(error.message, "couldn't get any text");
		});
	});

	describe("#getMarkdown()", function () {
		it("should number the sentences of a chunk through the chunk, after their IDs", function () {
			let chunk = makeTestChunk([
				'Owls hunt at night. They see well in the dark.',
				['heading', 'Diet'],
				['listitem', 'Mice and voles.'],
				['preformatted', 'x = 1.\ny = 2.'],
				['caption', 'Owls in flight.'],
				'Last one.',
			], { sections: [['Intro', null], ['Intro > Habits', 'Mice']] });

			assert.equal(Zotero.MCP.Text.getMarkdown(chunk, { chunk: 7 }), [
				'[c7.1] Owls hunt at night. [c7.2] They see well in the dark.',
				// The text's heading, under Intro, and where the Habits section starts
				'## Diet',
				'## Habits',
				'- [c7.3] Mice and voles.',
				// Code is one unit, its whitespace kept
				'[c7.4]\n```\nx = 1.\ny = 2.\n```',
				'(caption) [c7.5] Owls in flight.',
				'[c7.6] Last one.',
			].join('\n\n'));
			// Numbered as the sentences are, for citing them
			let sentences = Zotero.SDT.getSentences(chunk);
			assert.equal(sentences.length, 6);
			assert.equal(chunk.text.slice(sentences[1].start, sentences[1].end), 'They see well in the dark.');
			assert.equal(chunk.text.slice(sentences[3].start, sentences[3].end), 'x = 1.\ny = 2.');
		});

		it("should mark quotes, nested lists and headings that start sections", function () {
			let text = 'Methods\n\nA quote.\n\nFirst\n\nInner';
			let at = (part, ref, blocks) => ({
				start: text.indexOf(part),
				end: text.indexOf(part) + part.length,
				ref: [...ref, 0],
				offset: 0,
				blocks,
			});
			let outer = { type: 'list', ref: [2], ordered: true, startIndex: 1 };
			let chunk = {
				text,
				sections: [{ outlinePath: ['Intro', 'Methods'], start: 0 }],
				segments: [
					at('Methods', [0], [{ type: 'heading', ref: [0] }]),
					at('A quote.', [1, 0], [{ type: 'blockquote', ref: [1] }, { type: 'paragraph', ref: [1, 0] }]),
					at('First', [2, 0], [outer, { type: 'listitem', ref: [2, 0] }]),
					at('Inner', [2, 0, 1, 0], [
						outer,
						{ type: 'listitem', ref: [2, 0] },
						{ type: 'list', ref: [2, 0, 1], ordered: false },
						{ type: 'listitem', ref: [2, 0, 1, 0] },
					]),
				],
			};
			assert.equal(Zotero.MCP.Text.getMarkdown(chunk, { chunk: 0 }), [
				// At its section's depth
				'## Methods',
				'> [c0.1] A quote.',
				'1. [c0.2] First',
				'  - [c0.3] Inner',
			].join('\n\n'));
		});

		it("should give a table's rows of cells", function () {
			let text = 'Name\n\nValue';
			let cell = (cellText, i) => ({
				start: text.indexOf(cellText),
				end: text.indexOf(cellText) + cellText.length,
				ref: [0, 0, i, 0, 0],
				offset: 0,
				blocks: [
					{ type: 'table', ref: [0] },
					{ type: 'tablerow', ref: [0, 0] },
					{ type: 'tablecell', ref: [0, 0, i] },
					{ type: 'paragraph', ref: [0, 0, i, 0] },
				],
			});
			let chunk = { text, sections: [{ outlinePath: [], start: 0 }], segments: [cell('Name', 0), cell('Value', 1)] };

			assert.equal(Zotero.MCP.Text.getMarkdown(chunk, { chunk: 0 }), '| [c0.1] Name | [c0.2] Value |');
		});
	});

	describe("#getMarkdown() for plain text", function () {
		it("should give plain text as its paragraphs, its sentences without IDs", function () {
			let [chunk] = Zotero.SDT.getPlainTextChunks('First line\nwrapped. More.\n\nSecond paragraph.');
			assert.equal(Zotero.MCP.Text.getMarkdown(chunk), 'First line wrapped. More.\n\nSecond paragraph.');
		});

		it("should give code and math without IDs when there are none", function () {
			let chunk = makeTestChunk([['preformatted', 'x = 1.'], ['math', 'a^2']]);
			assert.equal(Zotero.MCP.Text.getMarkdown(chunk), '```\nx = 1.\n```\n\n$$a^2$$');
			assert.equal(Zotero.MCP.Text.getMarkdown(chunk, { page: 3 }), '[p3.1]\n```\nx = 1.\n```\n\n[p3.2] $$a^2$$');
		});
	});

	describe("#getPages()", function () {
		it("should give the pages of a PDF's structure", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let getPages = sinon.stub(Zotero.SDT, 'getPages')
				.resolves({ ok: true, pages: [{ pageIndex: 0, pageLabel: 'i', text: 'One.' }], missing: [], totalPages: 3 });
			assert.deepEqual(await Zotero.MCP.Text.getPages(attachment, [1], { deadline: Date.now() + 10000 }), {
				pages: [{ page: 1, pageIndex: 0, pageLabel: 'i', text: 'One.' }],
				plain: false,
				totalPages: 3,
				pending: [],
			});
			assert.isTrue(getPages.calledWith(attachment.id, [1], { isPriority: true, cachedOnly: false }));

			getPages.resolves({ ok: true, pages: [], missing: ['9'], totalPages: 3 });
			let error = await getPromiseError(Zotero.MCP.Text.getPages(attachment, ['9'], { deadline: Date.now() + 10000 }));
			assert.equal(error.message, `${attachment.key} has no page 9`);
		});

		it("should give pages of the full text until the structure is extracted", async function () {
			let attachment = await importFileAttachment('test.pdf');
			sinon.stub(Zotero.SDT, 'getPages').returns(new Promise(() => {}));
			Zotero.MCP.Text._structureWait = 50;
			try {
				let result = await Zotero.MCP.Text.getPages(attachment, [1], { deadline: Date.now() + 10000 });
				assert.equal(result.pages[0].page, 1);
				assert.include(result.pages[0].text, 'Zotero');
				assert.isTrue(result.plain);
				assert.match(result.notice, /still working out the file's structure.*sentences have no IDs/);

				let error = await getPromiseError(Zotero.MCP.Text.getPages(attachment, ['i'], { deadline: Date.now() + 10000 }));
				assert.include(error.message, "can't find them by label yet");
			}
			finally {
				Zotero.MCP.Text._structureWait = 15 * 1000;
			}
		});

		it("should say a file other than a PDF has no pages", async function () {
			let attachment = await importText('Plain text');
			let error = await getPromiseError(Zotero.MCP.Text.getPages(attachment, [1], { deadline: Date.now() + 10000 }));
			assert.include(error.message, 'has no pages');
		});
	});

	describe("#getChunks() with structureOnly", function () {
		it("should give no chunks, rather than cut the full text, without a structure", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let getItemChunks = sinon.stub(Zotero.SDT, 'getItemChunks').resolves({ ok: false, reason: 'failed' });
			let deadline = Date.now() + 10000;
			assert.deepEqual(await Zotero.MCP.Text.getChunks(attachment, { deadline, structureOnly: true }),
				{ chunks: null, plain: false, pending: false });

			getItemChunks.returns(new Promise(() => {}));
			assert.deepEqual(await Zotero.MCP.Text.getChunks(attachment, {
				deadline,
				structureDeadline: Date.now() + 50,
				structureOnly: true,
			}), { chunks: null, plain: false, pending: true });
		});
	});

	describe("#parseSentenceIDs()", function () {
		it("should give the chunk or page and the sentence of each ID", function () {
			assert.deepEqual(Zotero.MCP.Text.parseSentenceIDs(['c7.3', 'p12.4']), [
				{ chunk: 7, sentence: 3, id: 'c7.3' },
				{ page: 12, sentence: 4, id: 'p12.4' },
			]);
			assert.throws(() => Zotero.MCP.Text.parseSentenceIDs(['c7.3', 'x1']), "x1 isn't a sentence ID");
		});
	});

	describe("#getCitedSentences()", function () {
		// The cited sentences of a file with these chunks and pages
		async function cite(ids, chunks, pages = []) {
			let attachment = await importFileAttachment('test.pdf');
			sinon.stub(Zotero.SDT, 'getItemChunks').resolves({ ok: true, chunks });
			sinon.stub(Zotero.SDT, 'getPages').resolves({ ok: true, pages, missing: [], totalPages: pages.length });
			let [cited] = await Zotero.MCP.Text.getCitedSentences(
				attachment,
				[Zotero.MCP.Text.parseSentenceIDs(ids)],
				{ deadline: Date.now() + 10000 }
			);
			sinon.restore();
			return cited;
		}

		it("should give the ranges of each run of sentences next to each other", async function () {
			let chunks = [
				makeTestChunk(['One. Two. Three.', 'Four.']),
				makeTestChunk(['Five. Six.']),
			];

			// Two sentences of a paragraph, as one range of its text
			assert.deepEqual(await cite(['c0.1', 'c0.2'], chunks),
				{ text: 'One. Two.', runs: [[[[0, 0, 0], [0, 0, 9]]]] });
			// On into the next paragraph and the next chunk, in the text's order, each once
			assert.deepEqual(await cite(['c1.1', 'c0.4', 'c0.3', 'c0.4'], chunks), {
				text: 'Three. Four. Five.',
				runs: [[[[0, 0, 10], [0, 0, 16]], [[1, 0, 0], [1, 0, 5]], [[0, 0, 0], [0, 0, 5]]]],
			});
			// Sentences apart, each a run
			assert.deepEqual(await cite(['c0.1', 'c0.3'], chunks), {
				text: 'One. … Three.',
				runs: [[[[0, 0, 0], [0, 0, 4]]], [[[0, 0, 10], [0, 0, 16]]]],
			});
			assert.deepEqual(await cite(['c0.9'], chunks), { missing: { chunk: 0, sentence: 9, id: 'c0.9' } });
		});

		it("should give a sentence cited from a chunk and from a page once", async function () {
			let chunk = makeTestChunk(['One. Two.']);
			let page = { ...makeTestChunk(['One. Two.']), pageIndex: 0 };
			assert.deepEqual(await cite(['p1.1', 'c0.1'], [chunk], [page]),
				{ text: 'One.', runs: [[[[0, 0, 0], [0, 0, 4]]]] });
		});

		it("should give nothing for a chunk whose text couldn't be placed in the file", async function () {
			let chunk = { ...makeTestChunk(['One. Two.']), segments: null };
			assert.deepEqual(await cite(['c0.1'], [chunk]), { text: '', runs: [] });
		});
	});

	describe("#locateSentences()", function () {
		let parse = ids => Zotero.MCP.Text.parseSentenceIDs(ids);

		it("should find sentences in the chunks and pages of the cached structure, as they're read", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let chunk = makeTestChunk(['One. Two.', 'Three.']);
			let page = { ...makeTestChunk(['On a page.']), pageIndex: 1 };
			let getItemChunks = sinon.stub(Zotero.SDT, 'getItemChunks').resolves({ ok: true, chunks: [chunk] });
			let getPages = sinon.stub(Zotero.SDT, 'getPages')
				.resolves({ ok: true, pages: [page], missing: [], totalPages: 2 });
			let deadline = Date.now() + 10000;

			// As getMarkdown() numbers them
			assert.equal(Zotero.MCP.Text.getMarkdown(chunk, { chunk: 0 }), '[c0.1] One. [c0.2] Two.\n\n[c0.3] Three.');
			let cited = await Zotero.MCP.Text.getCitedSentences(
				attachment,
				[parse(['c0.2', 'c0.3']), parse(['p2.1']), parse(['c0.4'])],
				{ deadline }
			);
			assert.deepEqual(cited.map(({ text }) => text), ['Two. Three.', 'On a page.', undefined]);
			assert.deepEqual(cited[2], { missing: { chunk: 0, sentence: 4, id: 'c0.4' } });
			// Without extracting it
			assert.isTrue(getItemChunks.calledWith(attachment.id, { isPriority: true, segments: true, cachedOnly: true }));
			assert.isTrue(getPages.calledWith(attachment.id, [2], { isPriority: true, cachedOnly: true }));

			let position = { pageIndex: 0, rects: [[1, 2, 3, 4]] };
			let locateRanges = sinon.stub(Zotero.SDT, 'locateRanges').resolves({ ok: true, selections: [
				{ positions: [position], sections: [{ outlinePath: ['Intro'], start: 0 }], pageLabel: '1' },
				null,
				{
					positions: [{ pageIndex: 1, rects: [[5, 6, 7, 8]] }],
					sections: [{ outlinePath: ['Intro'], start: 0 }],
					pageLabel: '2',
				},
			] });
			let located = await Zotero.MCP.Text.locateSentences(
				attachment,
				[parse(['c0.1']), parse(['c0.3']), parse(['p2.1']), parse(['c9.1'])],
				{ deadline }
			);
			// Each citation's sentences as a run
			assert.lengthOf(locateRanges.firstCall.args[1], 3);
			assert.deepEqual(locateRanges.firstCall.args[2], { cachedOnly: true, isPriority: true });
			assert.deepEqual(located, [
				{ text: 'One.', positions: [position], outlinePath: ['Intro'], pageLabel: '1' },
				{ unresolved: true },
				{ text: 'On a page.', positions: [{ pageIndex: 1, rects: [[5, 6, 7, 8]] }], outlinePath: ['Intro'], pageLabel: '2' },
				{ missing: { chunk: 9, sentence: 1, id: 'c9.1' } },
			]);
		});

		it("should say when Zotero doesn't have the structure, rather than find sentences in the full text", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let getItemChunks = sinon.stub(Zotero.SDT, 'getItemChunks').resolves({ ok: false, reason: 'not-cached' });
			let deadline = Date.now() + 10000;
			let error = await getPromiseError(Zotero.MCP.Text.locateSentences(attachment, [parse(['c0.1'])], { deadline }));
			assert.instanceOf(error, Zotero.MCP.ToolError);
			assert.include(error.message, `doesn't have the structure of ${attachment.key}`);

			// Nor wait past the deadline
			getItemChunks.returns(new Promise(() => {}));
			error = await getPromiseError(
				Zotero.MCP.Text.getCitedSentences(attachment, [parse(['c0.1'])], { deadline: Date.now() + 50 })
			);
			assert.instanceOf(error, Zotero.MCP.Text.TextPendingError);
		});

		it("should say a file other than a PDF has no pages", async function () {
			let attachment = await importText('One. Two.');
			let error = await getPromiseError(
				Zotero.MCP.Text.locateSentences(attachment, [parse(['p1.1'])], { deadline: Date.now() + 10000 })
			);
			assert.include(error.message, 'has no pages');
		});
	});
});
